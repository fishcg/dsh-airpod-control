// dsh-airpod-control —— 浏览器端 half（client bundle）。
//
// 手写 CJS + ModuleLoader 包装，零构建步骤：不 import 任何 @deepseek-ai 的值
// （bundle purity gate 合规），cordis 服务经 exports.inject 的字符串名接入。
//
// 它做的事：
//   1. 盯住 uiSession.sessionStatus 里每个会话的 pendingInteraction（审批/提问卡片）
//   2. 卡片在的时候，每隔 0.7 秒问一次宿主半区的 /dsh-airpod-control/last-decision
//      （免 token、只读、不含任何会话内容，只有「最近一次决定」的形状）
//   3. 一旦这次审批已经被头部手势答过（决定的时刻晚于卡片出现的时刻），就把这张
//      已经失效的卡片 delegate 掉——内置审批卡片收到 delegation 会走 finally 的
//      remove()，卡片当场消失。
//
// 为什么需要它：手势是在宿主半区结算的；内置审批卡片只在「自己答的」或
// 「request.signal 被 abort」时才收卡片，而宿主被别的回答者结算后不会去 abort
// 远端那份展示，卡片就留在那儿了。这里补上最后一格：卡片自己知道自己过期了。
window.__ModuleLoader__.load({
  id: 'dsh-airpod-control',
  factory: () => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    var TAG = '[head-gesture]'
    var DECISION_URL = '/dsh-airpod-control/last-decision'
    var CURSOR_URL = '/dsh-airpod-control/cursor'
    // 卡片在的时候才真的发请求；没卡片时这一步只是读一次内存里的快照
    var POLL_MS = 700
    // 光标要跟得上摇头的节奏：300ms 一次，肉眼看起来是连续的
    var CURSOR_POLL_MS = 300
    var HIGHLIGHT_ATTR = 'data-head-gesture-current'
    var STYLE_ID = 'dsh-airpod-control-highlight-style'
    // 决定发生在「卡片出现之前」的不算数，这里给时钟误差留一点余量
    var CLOCK_SLACK_MS = 1500
    // 热重载会再跑一次 apply()：用 window 上的槽保证同时只有一个实例在跑
    var INSTANCE_SLOT = '__dshHeadGestureCardReaper'
    var SETUP_URL = '/dsh-airpod-control/setup'
    var SETUP_RUN_URL = '/dsh-airpod-control/setup/run'
    var SETUP_MOTION_URL = '/dsh-airpod-control/setup/motion'
    var BANNER_ID = 'dsh-airpod-control-setup'
    var DISMISS_KEY = 'dsh-airpod-control.setup.dismissed'
    var SETUP_POLL_MS = 5000
    var STEPS_ID = 'dsh-airpod-control-setup-steps'

    // —— 语音输入快捷键（按住 ⌥Space 说话）——
    // 官方语音输入插件没有快捷键：它的入口是输入框旁边那个麦克风按钮，录音中会
    // 换成「取消 + 停止」两个圆钮，并且整行带 data-voice-activity 标出当前阶段。
    // 这里不改官方包，只在 DOM 层按 class 后缀（CSS Module 会保留 _trigger /
    // _roundButton 后缀）找到它们，模拟点击：按下 = 开始，松开 = 停止并转录。
    var VOICE_TRIGGER_SELECTOR = 'button[class*="_trigger"]'
    var VOICE_ROUND_SELECTOR = 'button[class*="_roundButton"]'

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
      var disposeVoiceShortcut = null
      var inFlight = false
      // 卡片 key → 第一次看见它的时刻
      var born = new Map()
      var cursorTimer = null
      var cursorInFlight = false
      var setupTimer = null
      var setupBusy = false
      var setupLast = null
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

      // ── 一键安装引导 ────────────────────────────────────────────────────
      // 纯 DOM，不依赖界面框架：HeadOrbit 没装、或者装了但没连上时，右下角出现一张
      // 卡片，点一下就把「下载 → 安装 → 写配置 → 启动」全做完；权限只能由系统弹窗
      // 授予，所以那一步给一个直接跳到系统设置的按钮。
      function dismissed() {
        try {
          return window.localStorage.getItem(DISMISS_KEY) === '1'
        } catch (_) {
          return false
        }
      }

      function needsSetup(state) {
        if (!state || !state.app) return false
        return state.app.installed !== true || state.alive !== true
      }

      function makeEl(tag, styles, text) {
        var node = document.createElement(tag)
        if (styles) {
          for (var key in styles) node.style[key] = styles[key]
        }
        if (text !== undefined) node.textContent = text
        return node
      }

      function renderSteps(box, steps) {
        box.textContent = ''
        for (var i = 0; i < steps.length; i++) {
          var step = steps[i]
          var mark = step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'running' ? '…' : '·'
          var color = step.status === 'done' ? '#5ec27a' : step.status === 'failed' ? '#e5677a' : '#e6b95c'
          var row = makeEl('div', { fontSize: '12px', color: '#a9b0bd', lineHeight: '1.5' }, mark + ' ' + (step.detail || step.id))
          if (step.status !== 'done') row.style.color = color
          box.appendChild(row)
        }
      }

      function mountBanner() {
        var old = document.getElementById(BANNER_ID)
        if (old !== null) old.remove()
        var box = makeEl('div', {
          position: 'fixed',
          right: '20px',
          bottom: '20px',
          zIndex: '2147483000',
          width: '360px',
          padding: '14px 16px',
          borderRadius: '12px',
          background: '#1b1f27',
          color: '#e9edf5',
          boxShadow: '0 12px 32px rgba(0,0,0,.38)',
          font: '13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
          border: '1px solid #2e3440',
        })
        box.id = BANNER_ID

        var head = makeEl('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' })
        head.appendChild(makeEl('strong', { fontSize: '14px' }, '用点头 / 摇头回答 DSH'))
        var close = makeEl('button', { background: 'none', border: 'none', color: '#7e8797', cursor: 'pointer', fontSize: '16px', lineHeight: '1' }, '×')
        close.title = '暂时不装'
        close.onclick = function () {
          try {
            window.localStorage.setItem(DISMISS_KEY, '1')
          } catch (_) {
            /* 隐私模式下忽略 */
          }
          box.remove()
        }
        head.appendChild(close)
        box.appendChild(head)

        var state = setupLast || {}
        var status = needsSetup(state)
          ? state.app && state.app.installed === false
            ? '还没安装 HeadOrbit（点头/摇头认手势的那个菜单栏 App）。'
            : 'HeadOrbit 已经装了，但还没连上这个插件。'
          : 'HeadOrbit 已就绪。'
        box.appendChild(makeEl('div', { color: '#a9b0bd', marginBottom: '10px' }, status))

        var steps = makeEl('div', { marginBottom: '10px' })
        steps.id = STEPS_ID
        if (state.last && state.last.steps) renderSteps(steps, state.last.steps)
        box.appendChild(steps)

        var row = makeEl('div', { display: 'flex', gap: '8px' })
        var install = makeEl('button', {
          flex: '1',
          padding: '8px 12px',
          borderRadius: '8px',
          border: '1px solid #3b74d8',
          background: '#2f6ad4',
          color: '#fff',
          cursor: setupBusy ? 'default' : 'pointer',
          opacity: setupBusy ? '0.6' : '1',
          font: 'inherit',
        }, setupBusy ? '正在安装…' : state.app && state.app.installed === false ? '一键安装并配置' : '重新检查 / 修复')
        install.disabled = setupBusy
        install.onclick = function () {
          runSetup()
        }
        row.appendChild(install)

        var motion = makeEl('button', {
          padding: '8px 12px',
          borderRadius: '8px',
          border: '1px solid #3a4150',
          background: '#242a35',
          color: '#dfe5ef',
          cursor: 'pointer',
          font: 'inherit',
        }, '系统权限')
        motion.title = '打开系统设置的「动作与健身」，给 HeadOrbit 打勾'
        motion.onclick = function () {
          fetch(SETUP_MOTION_URL, { method: 'POST', cache: 'no-store' }).catch(function () {})
        }
        row.appendChild(motion)
        box.appendChild(row)

        box.appendChild(
          makeEl('div', { marginTop: '8px', fontSize: '11px', color: '#7e8797' },
            '安装到 ~/Applications；端口与 token 自动写入，不用手填。'),
        )
        document.body.appendChild(box)
        return box
      }

      function runSetup() {
        if (setupBusy) return
        setupBusy = true
        var box = mountBanner()
        var steps = document.getElementById(STEPS_ID) || box.lastChild
        renderSteps(steps, [{ id: 'start', status: 'running', detail: '正在下载并安装 HeadOrbit…' }])
        fetch(SETUP_RUN_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              setupBusy = false
              setupLast = setupLast || {}
              setupLast.last = body
              mountBanner()
              if (body && body.steps) log('setup finished', body.ok)
              return body
            })
          })
          .catch(function (err) {
            setupBusy = false
            warn('setup failed', err)
            mountBanner()
          })
      }

      function setupLoop() {
        if (stopped) return
        fetch(SETUP_URL, { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (res) {
            return res.ok ? res.json() : null
          })
          .then(function (state) {
            if (stopped || !state) return
            setupLast = state
            var box = document.getElementById(BANNER_ID)
            if (needsSetup(state) && !dismissed()) mountBanner()
            else if (box !== null && !setupBusy) box.remove()
          })
          .catch(function () {
            /* 宿主还没装好路由时静默 */
          })
        setupTimer = window.setTimeout(setupLoop, SETUP_POLL_MS)
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

      // ── 按住 ⌥Space 说话 ────────────────────────────────────────────────
      // 只做两件事：按下时点一下麦克风按钮；松开时如果还在录音，点一下停止。
      // 找不到按钮（没装官方语音插件）就完全不动，Option+Space 该输入什么还是什么。
      function voicePhase() {
        var row = document.querySelector('[data-voice-activity]')
        return row === null ? null : row.getAttribute('data-voice-activity')
      }

      function voiceTrigger() {
        var nodes = document.querySelectorAll(VOICE_TRIGGER_SELECTOR)
        for (var i = 0; i < nodes.length; i++) {
          if (!nodes[i].disabled) return nodes[i]
        }
        return null
      }

      function voiceStopButton() {
        var nodes = document.querySelectorAll(VOICE_ROUND_SELECTOR)
        return nodes.length === 0 ? null : nodes[nodes.length - 1]
      }

      function isVoiceShortcut(event) {
        return (
          event.code === 'Space' &&
          event.altKey === true &&
          event.ctrlKey !== true &&
          event.metaKey !== true &&
          event.shiftKey !== true
        )
      }

      function installVoiceShortcut() {
        var held = false

        function onKeyDown(event) {
          if (stopped || !isVoiceShortcut(event) || event.repeat === true) return
          var trigger = voiceTrigger()
          if (trigger === null) return
          event.preventDefault()
          event.stopPropagation()
          held = true
          try {
            trigger.click()
            log('voice shortcut: start')
          } catch (err) {
            warn('voice shortcut start failed', err)
          }
        }

        function onKeyUp(event) {
          if (!isVoiceShortcut(event) || !held) return
          held = false
          var phase = voicePhase()
          if (phase !== 'recording' && phase !== 'requesting') return
          var stop = voiceStopButton()
          if (stop === null) return
          event.preventDefault()
          event.stopPropagation()
          try {
            stop.click()
            log('voice shortcut: stop')
          } catch (err) {
            warn('voice shortcut stop failed', err)
          }
        }

        window.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('keyup', onKeyUp, true)
        return function () {
          window.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('keyup', onKeyUp, true)
        }
      }

      function teardown() {
        stopped = true
        if (typeof disposeVoiceShortcut === 'function') {
          try {
            disposeVoiceShortcut()
          } catch (_) {
            /* ignore */
          }
          disposeVoiceShortcut = null
        }
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        if (cursorTimer !== null) {
          window.clearTimeout(cursorTimer)
          cursorTimer = null
        }
        if (setupTimer !== null) {
          window.clearTimeout(setupTimer)
          setupTimer = null
        }
        var bannerBox = document.getElementById(BANNER_ID)
        if (bannerBox !== null) bannerBox.remove()
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
      setupLoop()
      disposeVoiceShortcut = installVoiceShortcut()
      log('mounted')
    }

    exports.name = 'dsh-airpod-control'
    exports.inject = ['uiSession']
    exports.apply = apply

    return module.exports
  },
})
