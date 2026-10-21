// dsh-head-gesture —— 浏览器端 half（client bundle）。
//
// 手写 CJS + ModuleLoader 包装，零构建步骤：不 import 任何 @deepseek-ai 的值
// （bundle purity gate 合规），cordis 服务经 exports.inject 的字符串名接入。
//
// 它做的事：
//   1. 盯住 uiSession.sessionStatus 里每个会话的 pendingInteraction（审批/提问卡片）
//   2. 卡片在的时候，每隔 0.7 秒问一次宿主半区的 /dsh-head-gesture/last-decision
//      （免 token、只读、不含任何会话内容，只有「最近一次决定」的形状）
//   3. 一旦这次审批已经被头部手势答过（决定的时刻晚于卡片出现的时刻），就把这张
//      已经失效的卡片 delegate 掉——内置审批卡片收到 delegation 会走 finally 的
//      remove()，卡片当场消失。
//
// 为什么需要它：手势是在宿主半区结算的；内置审批卡片只在「自己答的」或
// 「request.signal 被 abort」时才收卡片，而宿主被别的回答者结算后不会去 abort
// 远端那份展示，卡片就留在那儿了。这里补上最后一格：卡片自己知道自己过期了。
window.__ModuleLoader__.load({
  id: 'dsh-head-gesture',
  factory: () => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    var TAG = '[head-gesture]'
    var DECISION_URL = '/dsh-head-gesture/last-decision'
    var CURSOR_URL = '/dsh-head-gesture/cursor'
    // 卡片在的时候才真的发请求；没卡片时这一步只是读一次内存里的快照
    var POLL_MS = 700
    // 光标要跟得上摇头的节奏：300ms 一次，肉眼看起来是连续的
    var CURSOR_POLL_MS = 300
    var HIGHLIGHT_ATTR = 'data-head-gesture-current'
    var STYLE_ID = 'dsh-head-gesture-highlight-style'
    // 决定发生在「卡片出现之前」的不算数，这里给时钟误差留一点余量
    var CLOCK_SLACK_MS = 1500
    // 热重载会再跑一次 apply()：用 window 上的槽保证同时只有一个实例在跑
    var INSTANCE_SLOT = '__dshHeadGestureCardReaper'

    function log() {
      try {
        console.debug.apply(console, [TAG].concat(Array.prototype.slice.call(arguments)))
      } catch (_) {
        /* ignore */
      }
    }

    function warn() {
      try {
        console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments)))
      } catch (_) {
        /* ignore */
      }
    }

    function apply(ctx) {
      if (typeof window[INSTANCE_SLOT] === 'function') {
        try {
          window[INSTANCE_SLOT]()
        } catch (_) {
          /* 上一个实例自己清理失败不影响新实例 */
        }
      }

      var stopped = false
      var timer = null
      var inFlight = false
      // 卡片 key → 第一次看见它的时刻
      var born = new Map()
      var cursorTimer = null
      var cursorInFlight = false
      // 当前已经圈出来的选项文字，避免每轮都重画
      var painted = null

      /** 当前所有会话里挂着的卡片 */
      function cards() {
        var out = []
        try {
          var ui = ctx && ctx.uiSession
          var status = ui && ui.sessionStatus
          var snap = status && typeof status.getSnapshot === 'function' ? status.getSnapshot() : null
          if (!snap || typeof snap.forEach !== 'function') return out
          snap.forEach(function (entry, sessionId) {
            var pending = entry && entry.pendingInteraction
            if (pending && typeof pending === 'object' && typeof pending.key === 'string') {
              out.push({ sessionId: sessionId, pending: pending })
            }
          })
        } catch (err) {
          warn('read sessionStatus failed', err)
        }
        return out
      }

      /**
       * 把一张已经由手势答过的卡片收掉。
       * delegate()：内置卡片把它当成「我不答了」，会走 finally 的 remove()；
       * 没有 delegate 就退回 abort()，同样会收卡片，只是会抛一个 rejection。
       */
      function retire(item, decision) {
        var pending = item.pending
        try {
          if (typeof pending.delegate === 'function') {
            pending.delegate()
            log('card retired', pending.key, decision.kind, decision.outcome)
            return true
          }
          if (typeof pending.abort === 'function') {
            pending.abort(new Error('this request was answered by a head gesture'))
            log('card aborted', pending.key, decision.kind, decision.outcome)
            return true
          }
        } catch (err) {
          warn('retire failed', pending.key, err)
        }
        return false
      }

      /** 高亮样式只注入一次 */
      function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent =
          '[' + HIGHLIGHT_ATTR + ']{outline:2px solid #4c8dff !important;outline-offset:2px;' +
          'box-shadow:0 0 0 3px rgba(76,141,255,.28) !important;' +
          'background-color:rgba(76,141,255,.10) !important;' +
          'transition:box-shadow .12s ease,outline-color .12s ease}'
        document.head.appendChild(style)
      }

      function clearHighlight() {
        painted = null
        var marked = document.querySelectorAll('[' + HIGHLIGHT_ATTR + ']')
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(HIGHLIGHT_ATTR)
      }

      /**
       * 把「现在点头会选中的那一项」圈出来。做法是在整页里按文字找按钮：
       * 含这段文字的按钮里，文字长度和选项标签最接近的那个就是选项按钮本身
       * （卡片会把描述一起渲染进去，所以用长度差而不是相等来挑）。
       */
      function paint(option) {
        if (!option) {
          if (painted !== null) clearHighlight()
          return
        }
        if (painted === option) return
        ensureStyle()
        clearHighlight()
        painted = option
        var buttons = document.querySelectorAll('button, [role="button"]')
        var best = null
        var bestScore = Infinity
        for (var i = 0; i < buttons.length; i++) {
          var text = (buttons[i].textContent || '').replace(/\s+/g, ' ').trim()
          if (text.indexOf(option) === -1) continue
          var score = Math.abs(text.length - option.length)
          if (score < bestScore) {
            bestScore = score
            best = buttons[i]
          }
        }
        if (best) {
          best.setAttribute(HIGHLIGHT_ATTR, '1')
          log('cursor painted', option)
        }
      }

      /**
       * 轮询光标。不依赖 pendingInteraction 的形状（提问卡片不一定挂在那个字段上），
       * 直接信宿主半区回的「有没有在提问 + 当前第几项」；没在提问就把高亮清掉。
       */
      function cursorLoop() {
        if (stopped) return
        if (!cursorInFlight) {
          cursorInFlight = true
          fetch(CURSOR_URL, { cache: 'no-store', headers: { Accept: 'application/json' } })
            .then(function (res) {
              return res.ok ? res.json() : null
            })
            .then(function (payload) {
              cursorInFlight = false
              if (stopped) return
              paint(payload && payload.waiting && payload.kind === 'question' ? payload.option : null)
            })
            .catch(function () {
              cursorInFlight = false
            })
        }
        cursorTimer = window.setTimeout(cursorLoop, CURSOR_POLL_MS)
      }

      function probe() {
        var live = cards()
        var now = Date.now()
        var seen = Object.create(null)
        for (var i = 0; i < live.length; i++) {
          var key = live[i].pending.key
          seen[key] = true
          if (!born.has(key)) born.set(key, now)
        }
        born.forEach(function (_at, key) {
          if (!seen[key]) born.delete(key)
        })
        if (live.length === 0 || inFlight) return
        inFlight = true
        fetch(DECISION_URL, { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (res) {
            return res.ok ? res.json() : null
          })
          .then(function (payload) {
            inFlight = false
            if (stopped || !payload || !payload.decision) return
            var decision = payload.decision
            if (typeof decision.at !== 'number') return
            cards().forEach(function (item) {
              var pending = item.pending
              if (decision.kind && pending.kind && decision.kind !== pending.kind) return
              var appearedAt = born.get(pending.key)
              if (typeof appearedAt === 'number' && decision.at < appearedAt - CLOCK_SLACK_MS) return
              retire(item, decision)
            })
          })
          .catch(function (err) {
            inFlight = false
            warn('decision probe failed', err)
          })
      }

      function loop() {
        if (stopped) return
        try {
          probe()
        } catch (err) {
          warn('probe failed', err)
        }
        timer = window.setTimeout(loop, POLL_MS)
      }

      function teardown() {
        stopped = true
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        if (cursorTimer !== null) {
          window.clearTimeout(cursorTimer)
          cursorTimer = null
        }
        try {
          clearHighlight()
        } catch (_) {
          /* 页面正在卸载时忽略 */
        }
        if (window[INSTANCE_SLOT] === teardown) delete window[INSTANCE_SLOT]
      }

      window[INSTANCE_SLOT] = teardown
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return teardown
        })
      }
      loop()
      cursorLoop()
      log('mounted')
    }

    exports.name = 'dsh-head-gesture'
    exports.inject = ['uiSession']
    exports.apply = apply

    return module.exports
  },
})
