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
  factory: (require) => {
    'use strict'
    var react = require('react')
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
    // 已经落定的那个按钮（绿/红闪一下），和等着的那个按钮是两个属性
    var FLASH_ATTR = 'data-head-gesture-result'
    var STYLE_ID = 'dsh-airpod-control-highlight-style'
    var TOAST_ID = 'dsh-airpod-control-toast'
    // 结果也在小鲸鱼（dsh-whale-widget）头顶说一句：人本来就看着右下角那只鲸鱼，
    // 比在屏幕顶部弹一条更容易被看见。鲸鱼不在就退化成顶部提示。
    var WHALE_NOTE_ID = 'dsh-airpod-control-whale-note'
    var WHALE_NOTE_MS = 3600
    // 手势答完之后的提示停留多久：够看一眼就够，别挡着后面的操作
    var TOAST_MS = 2600
    // 卡片收了之后再多问几秒 /last-decision：答完的那一刻卡片是当场消失的
    var DECISION_LINGER_MS = 5000
    // 决定发生在「卡片出现之前」的不算数，这里给时钟误差留一点余量
    var CLOCK_SLACK_MS = 1500
    // 热重载会再跑一次 apply()：用 window 上的槽保证同时只有一个实例在跑
    var INSTANCE_SLOT = '__dshHeadGestureCardReaper'
    var SETTINGS_URL = '/dsh-airpod-control/settings'
    var SETUP_URL = '/dsh-airpod-control/setup'
    var SETUP_RUN_URL = '/dsh-airpod-control/setup/run'
    var SETUP_MOTION_URL = '/dsh-airpod-control/setup/motion'
    var BANNER_ID = 'dsh-airpod-control-setup'
    var DISMISS_KEY = 'dsh-airpod-control.setup.dismissed'
    var SETUP_POLL_MS = 5000
    var STEPS_ID = 'dsh-airpod-control-setup-steps'

    // —— 语音输入快捷键（按住 ⌃Space 说话）——
    // 官方语音输入插件没有快捷键：它的入口是输入框旁边那个麦克风按钮，录音中会
    // 换成「取消 + 停止」两个圆钮，并且整行带 data-voice-activity 标出当前阶段。
    // 这里不改官方包，只在 DOM 层按 class 后缀（CSS Module 会保留 _trigger /
    // _roundButton 后缀）找到它们，模拟点击：按下 = 开始，松开 = 停止并转录。
    // 语音插件的麦克风按钮包在 span.triggerAnchor 里（VoiceInput_module_css.triggerAnchor），
    // 这个锚点类名只属于语音插件，比 button[class*="_trigger"] 精确得多——后者可能命中
    // 别的 CSS Module 里同名的 trigger。
    var VOICE_ANCHOR_SELECTOR = 'span[class*="_triggerAnchor"] button'
    var VOICE_TRIGGER_SELECTOR = 'button[class*="_trigger"]'
    var VOICE_ROUND_SELECTOR = 'button[class*="_roundButton"]'
    // 兜底时用它认人（各语言下的「开始录音」）
    var VOICE_LABEL_RE = /录音|听写|语音|dictate|voice|record|speak|listen/i
    // 识别失败后那一行只剩「重新录音」按钮（中英文都认），用它接着说话
    var VOICE_RETRY_RE = /重新录音|重试|retry|record again/i
    var SHORTCUT_URL = '/dsh-airpod-control/shortcut'
    var MOTION_URL = '/dsh-airpod-control/motion'
    var CLIENT_STATE_URL = '/dsh-airpod-control/client-state'

    // ── 文案 ──────────────────────────────────────────────────────────────
    // 界面语言。优先顺序：设置页里用户明确选的 → 宿主报上来的系统语言 → 浏览器语言。
    // 单看 navigator.language 会被 Electron 坑：系统是中文、它照样报 en-US。
    function detectLang() {
      try {
        var nav = navigator.language || (navigator.languages && navigator.languages[0]) || ''
        if (String(nav).toLowerCase().indexOf('zh') === 0) return 'zh'
      } catch (_) {}
      return 'en'
    }
    var LANG = detectLang()
    var STRINGS = {
      zh: {
        bannerTitle: '用点头 / 摇头回答 DSH',
        bannerClose: '暂时不装',
        needInstall: '还没安装 HeadOrbit（点头/摇头认手势的那个菜单栏 App）。',
        notConnected: 'HeadOrbit 已经装了，但还没连上这个插件。',
        ready: 'HeadOrbit 已就绪。',
        installing: '正在安装…',
        install: '一键安装并配置',
        recheck: '重新检查 / 修复',
        permission: '系统权限',
        permissionTitle: '打开系统设置的「动作与健身」，给 HeadOrbit 打勾',
        footer: '装到 ~/Applications，端口和 token 自动写入，不用手动配。',
        stepInstalling: '正在下载并安装 HeadOrbit…',
        settingsIntro: '改完点「保存」，立即生效，不用重启。',
        sectionGesture: '手势幅度',
        hintGesture: '数值越小越灵敏；摇/点的幅度以你脖子舒服为准。留空保存＝用 App 自己算的值。',
        labelNod: '点头幅度',
        labelTurn: '摇头幅度',
        appCurrent: 'App 当前：点头 %s · 摇头 %s',
        appUnknown: 'App 幅度未知（耳机连上后会报一次）',
        meterNod: '实时点头',
        meterTurn: '实时摇头',
        sectionShortcut: '语音输入快捷键',
        hintShortcut: '同时按住两个方向键才录音，单个方向键照常移光标。',
        modeArrows: '同时按住 ← 和 →（推荐）',
        modeOff: '关闭快捷键',
        sectionQuestion: '提问选项',
        labelLanguage: '界面语言',
        langAuto: '跟随系统',
        hintLanguage: '插件界面的语言。Electron 里的浏览器语言常常报错，所以默认问系统要。',
        labelHighlight: '高亮当前选项',
        hintHighlight: '摇头切换选项时，在网页卡片上把当前项圈出来。',
        sectionAdvanced: '高级',
        labelDebounce: '连续手势去重（毫秒）',
        hintDebounce: '一次摇头的几下摆动可能被拆成多次，加大这个值可以合并得更狠。',
        labelRequireOnline: '只在 HeadOrbit 在线时接管',
        hintRequireOnline: '没戴耳机时，审批和提问照旧由网页卡片处理。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，立即生效',
        saveFailed: '保存失败',
        saveFailedOffline: '保存失败（连不上插件）',
        readFailed: '读不到设置（插件没响应）',
        sectionTitle: 'AirPods 控制',
        toastAllowed: '点头 → 允许',
        toastRejected: '摇头 → 拒绝',
        toastCancelled: '手势回答被取消了',
        toastUnavailable: '没有可用的回答者，已放弃',
        toastPicked: '点头确认：%s',
        toastAnswered: '已用手势提交答案',
        // 小鲸鱼气泡里那一句：短，只回答「刚才那个结果是啥」
        whaleAllowed: '已允许 %s',
        whaleRejected: '已拒绝 %s',
        whalePicked: '已选择 %s',
      },
      en: {
        bannerTitle: 'Answer DSH by nodding',
        bannerClose: 'Not now',
        needInstall: 'HeadOrbit (the menu-bar app that reads head gestures) is not installed yet.',
        notConnected: 'HeadOrbit is installed but has not reached this plugin yet.',
        ready: 'HeadOrbit is ready.',
        installing: 'Installing…',
        install: 'Install and configure',
        recheck: 'Recheck / repair',
        permission: 'Motion access',
        permissionTitle: 'Open System Settings → Privacy & Security → Motion & Fitness and enable HeadOrbit',
        footer: 'Installs to ~/Applications; port and token are written automatically.',
        stepInstalling: 'Downloading and installing HeadOrbit…',
        settingsIntro: 'Changes take effect as soon as you save — no restart needed.',
        sectionGesture: 'Gesture amplitude',
        hintGesture: 'Smaller is more sensitive. Choose what feels comfortable for your neck. Empty = let the app decide.',
        labelNod: 'Nod amplitude',
        labelTurn: 'Turn amplitude',
        appCurrent: 'App now: nod %s · turn %s',
        appUnknown: 'App amplitude unknown (reported once earbuds connect)',
        meterNod: 'Live nod',
        meterTurn: 'Live turn',
        sectionShortcut: 'Voice shortcut',
        hintShortcut: 'Hold both arrow keys to record; a single arrow key still moves the caret.',
        modeArrows: 'Hold ← and → together (recommended)',
        modeOff: 'Disable shortcut',
        sectionQuestion: 'Question options',
        labelLanguage: 'Language',
        langAuto: 'Follow system',
        hintLanguage: 'Language of this plugin interface. Electron often reports the wrong browser language, so the system setting wins.',
        labelHighlight: 'Highlight current option',
        hintHighlight: 'While shaking your head to switch options, outline the current one on the card.',
        sectionAdvanced: 'Advanced',
        labelDebounce: 'Gesture debounce (ms)',
        hintDebounce: 'One head shake is several swings; raise this to merge them.',
        labelRequireOnline: 'Take over only while HeadOrbit is online',
        hintRequireOnline: 'Without earbuds, approvals and questions stay on the web card.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved, effective now',
        saveFailed: 'Save failed',
        saveFailedOffline: 'Save failed (plugin unreachable)',
        readFailed: 'Could not read settings (plugin did not respond)',
        sectionTitle: 'AirPods control',
        toastAllowed: 'Nodded → allowed',
        toastRejected: 'Shook → rejected',
        toastCancelled: 'Gesture answer cancelled',
        toastUnavailable: 'No answerer available, gave up',
        toastPicked: 'Nodded on: %s',
        toastAnswered: 'Answered by gesture',
        whaleAllowed: 'Allowed %s',
        whaleRejected: 'Rejected %s',
        whalePicked: 'Picked %s',
      },
    }
    function t(key) {
      var table = STRINGS[LANG] || STRINGS.zh
      if (table[key] !== undefined) return table[key]
      return STRINGS.zh[key] !== undefined ? STRINGS.zh[key] : key
    }

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
      // 设置页里的偏好（语音快捷键 / 高亮开关 / 幅度…）；loadPluginSettings 会在挂载后拉一次
      var pluginSettings = {
        unitNod: null,
        unitTurn: null,
        voiceShortcut: 'arrows',
        cursorHighlight: true,
        debounceMs: null,
        requireHeadOrbit: null,
        language: 'auto',
        system: { language: null },
        app: { unitNod: null, unitTurn: null },
      }
      /**
       * 语言在挂载之后才确定：宿主知道系统语言（Electron 的 navigator.language 不可信），
       * 用户也可能在设置页里明确指定过。放在 apply 里面是因为要读 pluginSettings。
       */
      function applyPreferredLanguage() {
        var pref = pluginSettings.language || 'auto'
        var sys = pluginSettings.system && pluginSettings.system.language
        var next = pref === 'zh' || pref === 'en' ? pref : sys === 'zh' || sys === 'en' ? sys : detectLang()
        if (next !== LANG) {
          LANG = next
          log('language: ' + LANG)
          languageChanged = true
          // 启动时语言还没定（设置是异步拉回来的），所以真正的语言要在这里再报一次
          reportClientState('language')
        }
        return LANG
      }

      var timer = null
      var languageChanged = false
      // 设置页换语言后要整页重画：把 React 的 setState 挂在这里，mountSettingsPage 里调用
      var rerenderSettings = function () {}
      var disposeVoiceShortcut = null
      var disposeSettingsSection = null
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
      // 审批卡片里的两个按钮：点头落在「允许」上，摇头落在「拒绝」上
      var APPROVE_RE = /允许|同意|批准|allow|approve|accept/i
      var DENY_RE = /拒绝|deny|reject|decline/i
      var approvedEl = null
      // /last-decision 每 0.7 秒都会被问一次：同一个决定只弹一次提示
      var lastDecisionSeq = null
      // 卡片最后一次出现的时刻。卡片被手势答掉后是「当场消失」的，所以卡没了还得
      // 再多问几秒，才接得住「刚答完」那一拍——否则提示根本没机会弹出来。
      var lastCardAt = 0
      // 页面开始的时刻：比它还早的决定属于上一次会话，不要一刷新就弹旧提示
      var pageStartedAt = Date.now()
      var toastTimer = null
      var whaleTimer = null
      // 宿主说「有人在等回答」的时刻（/cursor）。卡片是从会话快照里认的，
      // 快照认不到时还有这一路信号，免得「已经答完了」这句话永远没人说。
      var sawWaitingAt = 0

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
          // 等着的那个按钮：加粗描边 + 一圈发光，尽量让人一眼看出「点头会按这个」
          '[' + HIGHLIGHT_ATTR + ']{outline:3px solid #4c8dff !important;outline-offset:2px;' +
          'box-shadow:0 0 0 5px rgba(76,141,255,.26),0 0 18px 2px rgba(76,141,255,.45) !important;' +
          'background-color:rgba(76,141,255,.16) !important;' +
          'transition:box-shadow .12s ease,outline-color .12s ease,background-color .12s ease}' +
          // 已经落定的那个按钮：绿/红闪一下，证明刚才按的是它
          '[' + FLASH_ATTR + '="allow"]{outline:3px solid #3ccf7a !important;outline-offset:2px;' +
          'box-shadow:0 0 0 6px rgba(60,207,122,.35),0 0 22px 4px rgba(60,207,122,.55) !important;' +
          'background-color:rgba(60,207,122,.26) !important;transition:none !important}' +
          '[' + FLASH_ATTR + '="deny"]{outline:3px solid #ff6b6b !important;outline-offset:2px;' +
          'box-shadow:0 0 0 6px rgba(255,107,107,.35),0 0 22px 4px rgba(255,107,107,.55) !important;' +
          'background-color:rgba(255,107,107,.26) !important;transition:none !important}' +
          // 手势答完之后弹的小提示：卡片收得比人能看清的速度还快，结果得单独说一句
          // 顶部中间：不挡输入框，也不挡审批卡片
          '#' + TOAST_ID + '{position:fixed;left:50%;top:18px;transform:translate(-50%,-10px) scale(.98);' +
          'z-index:2147483000;max-width:74vw;padding:9px 16px;border-radius:999px;' +
          'background:rgba(20,22,28,.94);color:#fff;font:500 13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;' +
          'text-align:center;pointer-events:none;opacity:0;visibility:hidden;' +
          'box-shadow:0 10px 28px rgba(0,0,0,.32);transition:opacity .16s ease,transform .16s ease}' +
          '#' + TOAST_ID + '[data-visible="1"]{opacity:1;visibility:visible;transform:translate(-50%,0) scale(1)}' +
          '#' + TOAST_ID + '[data-tone="allow"]{box-shadow:0 0 0 1.5px rgba(60,207,122,.85),0 10px 28px rgba(0,0,0,.32)}' +
          '#' + TOAST_ID + '[data-tone="deny"]{box-shadow:0 0 0 1.5px rgba(255,107,107,.85),0 10px 28px rgba(0,0,0,.32)}' +
          // 小鲸鱼（dsh-whale-widget）头顶那一句：白底 + 深蓝描边，和它自己画的泡泡一个调子，
          // 位置贴着鲸鱼角色的上边缘（拖动鲸鱼之后重新算），下面带一个小尖角指回鲸鱼。
          '#' + WHALE_NOTE_ID + '{position:fixed;z-index:2147483000;max-width:210px;padding:7px 12px;border-radius:13px;' +
          'background:#fff;color:#203170;border:2px solid #203170;' +
          'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;' +
          'text-align:center;pointer-events:none;opacity:0;transition:opacity .16s ease;' +
          'box-shadow:0 8px 20px rgba(0,0,0,.22)}' +
          '#' + WHALE_NOTE_ID + '[data-visible="1"]{opacity:1}' +
          '#' + WHALE_NOTE_ID + '::after{content:"";position:absolute;left:50%;top:100%;margin-left:-7px;' +
          'width:0;height:0;border:7px solid transparent;border-top-color:#203170}' +
          '#' + WHALE_NOTE_ID + '[data-tone="allow"]{color:#14603c;border-color:#1c6e49}' +
          '#' + WHALE_NOTE_ID + '[data-tone="allow"]::after{border-top-color:#1c6e49}' +
          '#' + WHALE_NOTE_ID + '[data-tone="deny"]{color:#a3132b;border-color:#c0203a}' +
          '#' + WHALE_NOTE_ID + '[data-tone="deny"]::after{border-top-color:#c0203a}'
        document.head.appendChild(style)
      }

      function clearHighlight() {
        painted = null
        var marked = document.querySelectorAll('[' + HIGHLIGHT_ATTR + ']')
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(HIGHLIGHT_ATTR)
      }

      function clearApproval() {
        if (approvedEl !== null) {
          try {
            approvedEl.removeAttribute(HIGHLIGHT_ATTR)
          } catch (_) {}
          approvedEl = null
        }
      }

      /**
       * 审批卡片：把「点头会按下的那个按钮」圈出来。
       * 不靠卡片自己的类名（一升级就变），而是先找一个「拒绝」按钮，再在它的容器的
       * 上级里找同级的「允许」按钮 —— 这两个按钮永远成对出现。
       */
      function paintApproval() {
        if (pluginSettings.cursorHighlight === false) {
          clearApproval()
          return
        }
        if (approvedEl !== null && document.contains(approvedEl)) return
        clearApproval()
        var pair = approvalButtons()
        if (pair === null || pair.approve === null) return
        ensureStyle()
        pair.approve.setAttribute(HIGHLIGHT_ATTR, '1')
        approvedEl = pair.approve
        log('approval painted', (pair.approve.textContent || '').trim())
      }

      /**
       * 审批卡片上的两个按钮：永远成对出现，所以先找「拒绝」，再在它的容器里找「允许」。
       * 不靠卡片自己的类名（一升级就变）。
       */
      function approvalButtons() {
        var buttons = document.querySelectorAll('button, [role="button"]')
        var deny = null
        for (var i = 0; i < buttons.length; i++) {
          var label = (buttons[i].textContent || '').replace(/\s+/g, ' ').trim()
          if (label.length <= 14 && DENY_RE.test(label)) {
            deny = buttons[i]
            break
          }
        }
        if (deny === null) return null
        var scope = deny.parentElement
        for (var depth = 0; depth < 4 && scope !== null; depth++) {
          var siblings = scope.querySelectorAll('button, [role="button"]')
          for (var j = 0; j < siblings.length; j++) {
            if (siblings[j] === deny) continue
            var text = (siblings[j].textContent || '').replace(/\s+/g, ' ').trim()
            if (text.length <= 14 && APPROVE_RE.test(text)) return { approve: siblings[j], deny: deny }
          }
          scope = scope.parentElement
        }
        return { approve: null, deny: deny }
      }

      /** 手势落定之后，把选中的那个按钮绿/红闪一下（卡片还在的时候才看得见） */
      function flashApproval(tone) {
        try {
          var pair = approvalButtons()
          if (pair === null) return
          var el = tone === 'deny' ? pair.deny : pair.approve
          if (el === null) return
          ensureStyle()
          el.setAttribute(FLASH_ATTR, tone === 'deny' ? 'deny' : 'allow')
          window.setTimeout(function () {
            try {
              el.removeAttribute(FLASH_ATTR)
            } catch (_) {}
          }, 1400)
        } catch (err) {
          warn('flash failed', err)
        }
      }

      /**
       * 手势答完之后的小提示。为什么非要它：宿主半区一结算，卡片是「当场」消失的，
       * 人根本来不及看清刚才亮的是哪个按钮——所以结果得单独说一句「点头 → 允许」。
       */
      function toast(text, tone) {
        try {
          var el = document.getElementById(TOAST_ID)
          if (el === null) {
            ensureStyle()
            el = document.createElement('div')
            el.id = TOAST_ID
            el.setAttribute('role', 'status')
            el.setAttribute('aria-live', 'polite')
            document.body.appendChild(el)
          }
          el.textContent = text
          el.setAttribute('data-tone', tone === 'deny' ? 'deny' : tone === 'allow' ? 'allow' : 'info')
          el.setAttribute('data-visible', '1')
          if (toastTimer !== null) window.clearTimeout(toastTimer)
          toastTimer = window.setTimeout(function () {
            toastTimer = null
            try {
              el.removeAttribute('data-visible')
            } catch (_) {}
          }, TOAST_MS)
        } catch (err) {
          warn('toast failed', err)
        }
      }

      /**
       * 小鲸鱼（dsh-whale-widget）的根节点。那个插件自己把根元素挂在 window 上
       * （它的注释写明是「供外部定位/调试」），所以这里只借它的位置来贴气泡，
       * 不改它的 DOM、也不跟它的渲染回路抢元素。
       */
      function whaleRoot() {
        try {
          var root = window.__dshWhaleRoot
          if (root && typeof root.getBoundingClientRect === 'function') return root
        } catch (_) {}
        return null
      }

      /**
       * 鲸鱼此刻「最高的那块」的顶边：它自己的气泡（.dshwv-pop）正显示时贴着气泡，
       * 否则贴着角色本身。不这样会让两句话叠在一起——鲸鱼本来也会在头顶冒气泡。
       */
      function whaleTop(root, rootRect) {
        try {
          var pop = root.querySelector('.dshwv-pop')
          if (pop !== null) {
            var style = window.getComputedStyle(pop)
            var rect = pop.getBoundingClientRect()
            var shown = style && style.display !== 'none' && style.visibility !== 'hidden' &&
              (style.opacity === '' || Number(style.opacity) > 0.05)
            if (shown && rect.height > 0) return rect.top < rootRect.top ? rect.top : rootRect.top
          }
        } catch (_) {}
        return rootRect.top
      }

      /**
       * 在鲸鱼头顶说一句话。鲸鱼没装、被禁用、或者还没挂上去时返回 false，
       * 由调用方退化成顶部提示——联动是加分项，不能变成「没鲸鱼就没反馈」。
       */
      function whaleNote(text, tone) {
        try {
          var root = whaleRoot()
          if (root === null) return false
          var rect = root.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
          ensureStyle()
          var el = document.getElementById(WHALE_NOTE_ID)
          if (el === null) {
            el = document.createElement('div')
            el.id = WHALE_NOTE_ID
            el.setAttribute('role', 'status')
            el.setAttribute('aria-live', 'polite')
            document.body.appendChild(el)
          }
          el.textContent = text
          el.setAttribute('data-tone', tone === 'deny' ? 'deny' : tone === 'allow' ? 'allow' : 'info')
          // 鲸鱼可以拖动：每次说话都按它此刻的位置重算，别用缓存
          var cx = rect.left + rect.width / 2
          if (cx < 112) cx = 112
          if (cx > window.innerWidth - 112) cx = window.innerWidth - 112
          el.style.left = Math.round(cx) + 'px'
          el.style.top = Math.round(Math.max(12, whaleTop(root, rect) - 12)) + 'px'
          el.style.transform = 'translate(-50%,-100%)'
          el.setAttribute('data-visible', '1')
          if (whaleTimer !== null) window.clearTimeout(whaleTimer)
          whaleTimer = window.setTimeout(function () {
            whaleTimer = null
            try {
              el.removeAttribute('data-visible')
            } catch (_) {}
          }, WHALE_NOTE_MS)
          return true
        } catch (err) {
          warn('whale note failed', err)
          return false
        }
      }

      /** 说结果：优先小鲸鱼气泡，没有鲸鱼就顶部提示。返回走了哪条通道（诊断用） */
      function notify(text, tone) {
        if (whaleNote(text, tone)) return 'whale'
        toast(text, tone)
        return 'toast'
      }

      /** 半区心跳：告诉宿主「我活着、我是什么语言、我刚说了什么」 */
      function reportClientState(kind, extra) {
        try {
          var payload = { kind: kind, lang: LANG, at: Date.now() }
          if (extra) {
            if (extra.text !== undefined) payload.text = extra.text
            if (extra.channel !== undefined) payload.channel = extra.channel
          }
          fetch(CLIENT_STATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(function () {
            /* 心跳丢了不影响功能 */
          })
        } catch (_) {
          /* ignore */
        }
      }

      /** 说一句 + 记一笔：排查时能看到「说了什么、走的气泡还是提示条」 */
      function says(text, tone) {
        var channel = notify(text, tone)
        reportClientState('note', { text: text, channel: channel })
      }

      /** 文案里的 %s：没有名字就把占位连同空格一起去掉（「已允许」而不是「已允许 」） */
      function fmt(template, value) {
        if (value === null || value === undefined || value === '') return template.replace(/\s*%s\s*$/, '')
        return template.replace('%s', value)
      }

      /** 名字太长会把鲸鱼的气泡撑爆：压成一行、截断，宁可少说也不要糊成一片 */
      function shortText(value) {
        if (typeof value !== 'string') return ''
        var text = value.replace(/\s+/g, ' ').trim()
        if (text.length > 16) text = text.slice(0, 15) + '…'
        return text
      }

      /** 一个决定落定之后：闪按钮 + 说一句到底选了什么 */
      function showDecision(decision) {
        var outcome = decision.outcome
        if (decision.kind === 'approval') {
          var tool = shortText(decision.toolName)
          if (outcome === 'allowed-once') {
            flashApproval('allow')
            says(fmt(t('whaleAllowed'), tool), 'allow')
            return
          }
          if (outcome === 'rejected') {
            flashApproval('deny')
            says(fmt(t('whaleRejected'), tool), 'deny')
            return
          }
          says(outcome === 'cancelled' ? t('toastCancelled') : t('toastUnavailable'), 'info')
          return
        }
        if (decision.kind === 'question') {
          flashApproval('allow')
          var option = shortText(decision.option)
          if (option === '') {
            says(t('toastAnswered'), 'allow')
            return
          }
          says(fmt(t('whalePicked'), option), 'allow')
        }
      }

      /**
       * 把「现在点头会选中的那一项」圈出来。做法是在整页里按文字找按钮：
       * 含这段文字的按钮里，文字长度和选项标签最接近的那个就是选项按钮本身
       * （卡片会把描述一起渲染进去，所以用长度差而不是相等来挑）。
       */
      function paint(option) {
        if (pluginSettings.cursorHighlight === false) option = null
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
              var waiting = payload !== null && payload.waiting === true
              // 老宿主对审批回的是 waiting:false + kind:'approval'，别被它骗过去
              var kind = payload === null ? null : waiting ? payload.kind : payload.kind === 'approval' ? 'approval' : null
              if (kind !== null) sawWaitingAt = Date.now()
              if (kind === 'question') {
                clearApproval()
                paint(payload.option)
              } else if (kind === 'approval') {
                paint(null)
                paintApproval()
              } else {
                paint(null)
                clearApproval()
              }
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
        head.appendChild(makeEl('strong', { fontSize: '14px' }, t('bannerTitle')))
        var close = makeEl('button', { background: 'none', border: 'none', color: '#7e8797', cursor: 'pointer', fontSize: '16px', lineHeight: '1' }, '×')
        close.title = t('bannerClose')
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
            ? t('needInstall')
            : t('notConnected')
          : t('ready')
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
        }, setupBusy ? t('installing') : state.app && state.app.installed === false ? t('install') : t('recheck'))
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
        }, t('permission'))
        motion.title = t('permissionTitle')
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
        renderSteps(steps, [{ id: 'start', status: 'running', detail: t('stepInstalling') }])
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
        if (live.length > 0) lastCardAt = now
        var quietAt = lastCardAt > sawWaitingAt ? lastCardAt : sawWaitingAt
        // 卡片被手势答掉的那一刻宿主就把它收了，所以卡没了还得再问几秒，
        // 否则「点头 → 允许」这句提示永远等不到那个决定。
        if (inFlight) return
        if (live.length === 0 && now - quietAt > DECISION_LINGER_MS) return
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
            // 同一个决定只处理一次：/last-decision 是「最近一次」，会一直被问
            if (decision.seq === lastDecisionSeq) return
            // 比本页还早的决定属于上一次会话，别一刷新就弹旧提示
            if (decision.at < pageStartedAt - CLOCK_SLACK_MS) return
            lastDecisionSeq = decision.seq
            showDecision(decision)
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

      // ── 语音输入快捷键：同时按住 ← 和 → 说话 ───────────────────────────────
      // 为什么是「两个键一起按」：方向键是输入框里最常用的键（移光标），
      // 单按任何一个都不能抢；而同时按住左右两个方向键在正常编辑里没有用途，
      // 所以拿它当「按住说话」：两键都按下就开始录音，松开任意一个就结束并转录。
      //
      // 只做两件事：按下时点一下麦克风按钮；松开时如果还在录音，点一下停止。
      // 录音太短会让 MediaRecorder 的第一块数据还没落盘就被停掉，解码时直接报
      // "Unable to decode audio data"。所以松手后至少要等这么久才真的去点停止。
      var MIN_RECORD_MS = 900
      // 从点下麦克风到真正进入 recording 可能要等权限/设备就绪，最多等这么久
      var MAX_START_WAIT_MS = 2500

      function voicePhase() {
        var row = document.querySelector('[data-voice-activity]')
        return row === null ? null : row.getAttribute('data-voice-activity')
      }

      function voiceTrigger() {
        var anchored = document.querySelectorAll(VOICE_ANCHOR_SELECTOR)
        for (var i = 0; i < anchored.length; i++) {
          if (!anchored[i].disabled) return anchored[i]
        }
        var nodes = document.querySelectorAll(VOICE_TRIGGER_SELECTOR)
        for (var j = 0; j < nodes.length; j++) {
          var label = nodes[j].getAttribute('aria-label') || ''
          if (!nodes[j].disabled && VOICE_LABEL_RE.test(label)) return nodes[j]
        }
        return null
      }

      /** 探针用：候选按钮长什么样（只报标签数量，不含内容） */
      function voiceCandidates() {
        var out = []
        var nodes = document.querySelectorAll(VOICE_TRIGGER_SELECTOR)
        for (var i = 0; i < nodes.length && i < 6; i++) {
          out.push((nodes[i].getAttribute('aria-label') || '?').slice(0, 24))
        }
        return out
      }

      function voiceRetryButton() {
        var nodes = document.querySelectorAll(VOICE_ROUND_SELECTOR)
        if (nodes.length === 0) return null
        for (var i = 0; i < nodes.length; i++) {
          var label = nodes[i].getAttribute('aria-label') || ''
          if (!nodes[i].disabled && VOICE_RETRY_RE.test(label)) return nodes[i]
        }
        // 行里只有「取消 + 重新录音」两个圆按钮，兜底取最后一个（取消在前）
        var last = nodes[nodes.length - 1]
        return last.disabled ? null : last
      }

      // 这些阶段真的在忙，不能再起一次；feedback（失败/重试那一行）可以接着来
      function isBusyPhase() {
        var phase = voicePhase()
        if (phase === null) return false
        return phase !== 'feedback'
      }

      function voiceStopButton() {
        var nodes = document.querySelectorAll(VOICE_ROUND_SELECTOR)
        return nodes.length === 0 ? null : nodes[nodes.length - 1]
      }

      // 探针：只上报「到了哪一步」，方便真机排查「按了没反应」。不带任何文本内容。
      function reportShortcut(event, reason) {
        try {
          fetch(SHORTCUT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: event, reason: reason || null }),
          }).catch(function () {
            /* 探针失败不影响功能 */
          })
        } catch (_) {
          /* ignore */
        }
      }

      function isCtrlSpace(event) {
        return (
          event.code === 'Space' &&
          event.ctrlKey === true &&
          event.altKey !== true &&
          event.metaKey !== true &&
          event.shiftKey !== true
        )
      }

      function isArrow(event) {
        return (
          (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
          event.ctrlKey !== true &&
          event.altKey !== true &&
          event.metaKey !== true &&
          event.shiftKey !== true
        )
      }

      /**
       * 快捷键：同时按住 ← 和 → 说话，松开任意一个就停。
       * 单个方向键完全不拦截（光标照常移动），所以不会影响日常输入。
       */
      function installVoiceShortcut() {
        var leftDown = false
        var rightDown = false
        // 正在用「双方向键」录音
        var active = false
        // 这次录音是什么时候开始的（点下麦克风那一刻）
        var startedAt = 0
        // 松手后等「够长 / 真的在录」的定时器
        var stopTimer = null

        function startRecording(source) {
          // 上一轮失败（比如「未识别到语音」）之后，那一行是「重试录音」按钮，没有麦克风按钮
          if (voicePhase() === 'feedback') {
            var retry = voiceRetryButton()
            if (retry === null) {
              reportShortcut('no-trigger', source + '+retry')
              return false
            }
            try {
              retry.click()
              startedAt = Date.now()
              reportShortcut('start', source + '+retry')
              log('voice shortcut: restart after feedback (' + source + ')')
              return true
            } catch (err) {
              warn('voice shortcut retry failed', err)
              return false
            }
          }
          var trigger = voiceTrigger()
          if (trigger === null) {
            reportShortcut('no-trigger', source)
            return false
          }
          try {
            trigger.click()
            startedAt = Date.now()
            reportShortcut('start', source)
            log('voice shortcut: start (' + source + ')')
            // 600ms 后再看一眼：真的进录音了没有？没进的话是弹了设置对话框，还是完全没反应？
            window.setTimeout(function () {
              if (stopped) return
              var phase = voicePhase()
              if (phase !== null) {
                reportShortcut('phase', String(phase))
                return
              }
              var dialog = document.querySelector('[role="dialog"]')
              reportShortcut('no-record', dialog === null ? 'no-dialog' : 'dialog-open')
            }, 600)
            return true
          } catch (err) {
            warn('voice shortcut start failed', err)
            return false
          }
        }

        function resetKeys() {
          leftDown = false
          rightDown = false
        }

        function onKeyDown(event) {
          if (stopped) return
          if (pluginSettings.voiceShortcut === 'off') return

          // ⌃Space：备用的单键入口
          if (isCtrlSpace(event)) {
            if (pluginSettings.voiceShortcut !== 'ctrl-space') return
            if (event.repeat === true) return
            if (isBusyPhase()) return
            event.preventDefault()
            event.stopPropagation()
            startRecording('ctrl-space')
            return
          }

          if (!isArrow(event)) return
          if (pluginSettings.voiceShortcut !== 'arrows') return

          if (event.key === 'ArrowLeft') leftDown = true
          if (event.key === 'ArrowRight') rightDown = true

          if (active === true) {
            // 录音中：方向键全部拦下，别让光标乱跑
            event.preventDefault()
            event.stopPropagation()
            return
          }

          if (leftDown === true && rightDown === true) {
            // 第二个键按下这一下也拦掉，避免光标多走一格
            event.preventDefault()
            event.stopPropagation()
            if (isBusyPhase()) return
            if (startRecording('arrows')) active = true
            return
          }

          // 只按了一个方向键：完全放行
        }

        function onKeyUp(event) {
          if (stopped) return
          if (pluginSettings.voiceShortcut === 'off') return
          if (!isArrow(event)) return

          if (event.key === 'ArrowLeft') leftDown = false
          if (event.key === 'ArrowRight') rightDown = false

          if (active !== true) return

          // 松开任意一个就停
          active = false
          event.preventDefault()
          event.stopPropagation()
          requestStop(0)
        }

        function onBlur() {
          resetKeys()
          if (active === true) {
            active = false
            requestStop(0)
          }
        }

        /**
         * 点停止。两个原因会延后：
         *   1. 录音还没真正开始（requesting）——等它进入 recording；
         *   2. 录的时间太短——等够 MIN_RECORD_MS，否则解码会失败。
         * waited 是已经等过的毫秒数，递归给自己用。
         */
        function requestStop(waited) {
          if (stopped) return
          var phase = voicePhase()
          var elapsed = Date.now() - startedAt

          if (phase === 'requesting' || (phase === null && elapsed < MAX_START_WAIT_MS && waited < MAX_START_WAIT_MS)) {
            if (waited >= MAX_START_WAIT_MS) {
              reportShortcut('no-phase', String(phase))
              return
            }
            stopTimer = window.setTimeout(function () {
              requestStop(waited + 120)
            }, 120)
            return
          }

          if (phase !== 'recording') {
            reportShortcut('no-phase', String(phase))
            return
          }

          if (elapsed < MIN_RECORD_MS) {
            stopTimer = window.setTimeout(function () {
              requestStop(waited)
            }, MIN_RECORD_MS - elapsed)
            return
          }

          var stop = voiceStopButton()
          if (stop === null) {
            reportShortcut('no-stop', String(phase))
            return
          }
          try {
            stop.click()
            reportShortcut('stop', 'held=' + elapsed + 'ms')
            log('voice shortcut: stop (held ' + elapsed + 'ms)')
          } catch (err) {
            warn('voice shortcut stop failed', err)
          }
        }

        window.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('keyup', onKeyUp, true)
        window.addEventListener('blur', onBlur)
        return function () {
          if (stopTimer !== null) window.clearTimeout(stopTimer)
          stopTimer = null
          window.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('keyup', onKeyUp, true)
          window.removeEventListener('blur', onBlur)
        }
      }

      // ── 设置页：设置 → 「点头 / 摇头」 ───────────────────────────────────
      // 纯 DOM 表单一枚，React 那层只提供一个容器：不用 JSX 构建、也不跟宿主的
      // 组件库版本绑死；样式全部走 inherit + 极少量内联，跟随主题明暗。
      function settingsRow(labelText, control) {
        var row = document.createElement('label')
        row.style.display = 'flex'
        row.style.alignItems = 'center'
        row.style.gap = '12px'
        row.style.padding = '8px 0'
        row.style.cursor = 'pointer'
        var name = document.createElement('span')
        name.textContent = labelText
        name.style.flex = '0 0 156px'
        name.style.fontSize = '13px'
        row.appendChild(name)
        row.appendChild(control)
        return row
      }

      function settingsHint(text) {
        var p = document.createElement('p')
        p.textContent = text
        p.style.margin = '2px 0 10px'
        p.style.fontSize = '12px'
        p.style.opacity = '0.62'
        return p
      }

      function settingsHeading(text) {
        var h = document.createElement('h4')
        h.textContent = text
        h.style.margin = '18px 0 2px'
        h.style.fontSize = '13px'
        h.style.fontWeight = '600'
        h.style.opacity = '0.9'
        return h
      }

      function sliderRow(labelText, min, max, getValue, setValue, describe) {
        var wrap = document.createElement('div')
        wrap.style.display = 'flex'
        wrap.style.alignItems = 'center'
        wrap.style.gap = '10px'
        wrap.style.flex = '1'
        var input = document.createElement('input')
        input.type = 'range'
        input.min = String(min)
        input.max = String(max)
        input.step = '1'
        input.style.flex = '1'
        input.style.maxWidth = '240px'
        input.value = String(getValue())
        var out = document.createElement('span')
        out.style.fontSize = '12px'
        out.style.opacity = '0.8'
        out.style.minWidth = '72px'
        var refresh = function () {
          out.textContent = describe(Number(input.value))
        }
        refresh()
        input.addEventListener('input', function () {
          setValue(Number(input.value))
          refresh()
        })
        wrap.appendChild(input)
        wrap.appendChild(out)
        return { row: settingsRow(labelText, wrap), input: input, refresh: refresh, set: function (v) { input.value = String(v); refresh() } }
      }

      /** 设置页里的实时幅度条：两根（点头 / 摇头），带阈值刻线 */
      function motionMeter() {
        var wrap = document.createElement('div')
        wrap.style.display = 'grid'
        wrap.style.gap = '8px'
        wrap.style.marginTop = '10px'

        function bar(labelText, color) {
          var row = document.createElement('div')
          row.style.display = 'grid'
          row.style.gridTemplateColumns = '78px 1fr 74px'
          row.style.alignItems = 'center'
          row.style.gap = '8px'

          var label = document.createElement('span')
          label.textContent = labelText
          label.style.fontSize = '12px'
          label.style.opacity = '0.7'

          var track = document.createElement('div')
          track.style.position = 'relative'
          track.style.height = '8px'
          track.style.borderRadius = '999px'
          track.style.background = 'rgba(127,127,127,0.22)'

          var fill = document.createElement('div')
          fill.style.position = 'absolute'
          fill.style.left = '0'
          fill.style.top = '0'
          fill.style.bottom = '0'
          fill.style.width = '0%'
          fill.style.borderRadius = '999px'
          fill.style.background = color
          fill.style.transition = 'width 120ms linear'

          var mark = document.createElement('div')
          mark.style.position = 'absolute'
          mark.style.top = '-4px'
          mark.style.bottom = '-4px'
          mark.style.width = '2px'
          mark.style.background = 'rgba(255,120,120,0.95)'
          mark.style.left = '0%'

          track.appendChild(fill)
          track.appendChild(mark)

          var value = document.createElement('span')
          value.style.fontSize = '12px'
          value.style.textAlign = 'right'
          value.style.opacity = '0.7'

          row.appendChild(label)
          row.appendChild(track)
          row.appendChild(value)
          wrap.appendChild(row)
          return { fill: fill, mark: mark, value: value }
        }

        return {
          row: wrap,
          nod: bar(t('meterNod'), '#4c8dff'),
          turn: bar(t('meterTurn'), '#43b581'),
        }
      }

      function mountSettingsPage(host) {
        host.textContent = ''
        host.style.font = 'inherit'
        host.style.color = 'inherit'
        host.style.maxWidth = '620px'

        var intro = document.createElement('p')
        intro.textContent = t('settingsIntro')
        intro.style.margin = '0 0 4px'
        intro.style.fontSize = '13px'
        intro.style.opacity = '0.75'
        host.appendChild(intro)

        // ── 手势幅度 ──
        host.appendChild(settingsHeading(t('sectionGesture')))
        host.appendChild(
          settingsHint(t('hintGesture')),
        )
        var fallbackNod = function () { return pluginSettings.unitNod ?? (pluginSettings.app && pluginSettings.app.unitNod) ?? 12 }
        var fallbackTurn = function () { return pluginSettings.unitTurn ?? (pluginSettings.app && pluginSettings.app.unitTurn) ?? 19 }
        var nod = sliderRow(t('labelNod'), 8, 22, fallbackNod, function (v) { draft.unitNod = v }, function (v) { return v + '°' })
        var turn = sliderRow(t('labelTurn'), 12, 32, fallbackTurn, function (v) { draft.unitTurn = v }, function (v) { return v + '°' })
        host.appendChild(nod.row)
        host.appendChild(turn.row)
        var appLine = document.createElement('div')
        appLine.style.fontSize = '12px'
        appLine.style.opacity = '0.55'
        appLine.style.marginTop = '4px'
        host.appendChild(appLine)
        var meter = motionMeter()
        host.appendChild(meter.row)

        // 实时幅度：200ms 一次，只在这页打开时轮询
        var motionTimer = null
        var motionInFlight = false
        function paintMotion(m) {
          var nodLimit = Math.max(16, (m.nod || 12) * 1.6)
          var turnLimit = Math.max(24, (m.turn || 19) * 1.6)
          meter.nod.fill.style.width = Math.min(100, (m.pitch / nodLimit) * 100) + '%'
          meter.nod.mark.style.left = Math.min(100, ((m.nod || 12) / nodLimit) * 100) + '%'
          meter.nod.value.textContent = (m.pitch || 0).toFixed(1) + (m.nod ? ' / ' + m.nod + '°' : '°')
          meter.turn.fill.style.width = Math.min(100, (m.yaw / turnLimit) * 100) + '%'
          meter.turn.mark.style.left = Math.min(100, ((m.turn || 19) / turnLimit) * 100) + '%'
          meter.turn.value.textContent = (m.yaw || 0).toFixed(1) + (m.turn ? ' / ' + m.turn + '°' : '°')
        }
        function pollMotion() {
          if (stopped) return
          if (!motionInFlight) {
            motionInFlight = true
            fetch(MOTION_URL, { cache: 'no-store', headers: { Accept: 'application/json' } })
              .then(function (res) {
                return res.ok ? res.json() : null
              })
              .then(function (m) {
                motionInFlight = false
                if (stopped || m === null) return
                paintMotion(m)
              })
              .catch(function () {
                motionInFlight = false
              })
          }
          motionTimer = window.setTimeout(pollMotion, 200)
        }
        pollMotion()

        // ── 语音输入 ──
        host.appendChild(settingsHeading(t('sectionShortcut')))
        host.appendChild(settingsHint(t('hintShortcut')))
        var modeWrap = document.createElement('div')
        modeWrap.style.display = 'flex'
        modeWrap.style.flexDirection = 'column'
        var modes = [
          ['arrows', t('modeArrows')],
          ['ctrl-space', '⌃Space'],
          ['off', t('modeOff')],
        ]
        modes.forEach(function (item) {
          var row = document.createElement('label')
          row.style.display = 'flex'
          row.style.alignItems = 'center'
          row.style.gap = '8px'
          row.style.padding = '5px 0'
          row.style.fontSize = '13px'
          row.style.cursor = 'pointer'
          var input = document.createElement('input')
          input.type = 'radio'
          input.name = 'dsh-airpod-control-shortcut'
          input.value = item[0]
          input.checked = pluginSettings.voiceShortcut === item[0]
          input.addEventListener('change', function () {
            if (input.checked) draft.voiceShortcut = item[0]
          })
          var text = document.createElement('span')
          text.textContent = item[1]
          row.appendChild(input)
          row.appendChild(text)
          modeWrap.appendChild(row)
        })
        host.appendChild(modeWrap)

        // ── 显示 ──
        host.appendChild(settingsHeading(t('sectionQuestion')))
        var langSelect = document.createElement('select')
        langSelect.style.padding = '3px 6px'
        langSelect.style.font = 'inherit'
        ;[
          ['auto', t('langAuto')],
          ['zh', '中文'],
          ['en', 'English'],
        ].forEach(function (item) {
          var option = document.createElement('option')
          option.value = item[0]
          option.textContent = item[1]
          langSelect.appendChild(option)
        })
        langSelect.value = pluginSettings.language || 'auto'
        langSelect.addEventListener('change', function () {
          draft.language = langSelect.value
        })
        host.appendChild(settingsRow(t('labelLanguage'), langSelect))
        host.appendChild(settingsHint(t('hintLanguage')))
        var highlight = document.createElement('input')
        highlight.type = 'checkbox'
        highlight.checked = pluginSettings.cursorHighlight !== false
        highlight.addEventListener('change', function () {
          draft.cursorHighlight = highlight.checked
        })
        var highlightRow = settingsRow(t('labelHighlight'), highlight)
        host.appendChild(highlightRow)
        host.appendChild(settingsHint(t('hintHighlight')))

        // ── 高级 ──
        host.appendChild(settingsHeading(t('sectionAdvanced')))
        var debounce = document.createElement('input')
        debounce.type = 'number'
        debounce.min = '0'
        debounce.max = '5000'
        debounce.step = '50'
        debounce.style.width = '88px'
        debounce.style.padding = '3px 6px'
        debounce.value = String(pluginSettings.debounceMs ?? 200)
        debounce.addEventListener('change', function () {
          draft.debounceMs = Number(debounce.value)
        })
        host.appendChild(settingsRow(t('labelDebounce'), debounce))
        host.appendChild(settingsHint(t('hintDebounce')))

        var requireOnline = document.createElement('input')
        requireOnline.type = 'checkbox'
        requireOnline.checked = pluginSettings.requireHeadOrbit !== false
        requireOnline.addEventListener('change', function () {
          draft.requireHeadOrbit = requireOnline.checked
        })
        host.appendChild(settingsRow(t('labelRequireOnline'), requireOnline))
        host.appendChild(settingsHint(t('hintRequireOnline')))

        // ── 保存 ──
        var actions = document.createElement('div')
        actions.style.display = 'flex'
        actions.style.alignItems = 'center'
        actions.style.gap = '12px'
        actions.style.marginTop = '16px'
        var save = document.createElement('button')
        save.type = 'button'
        save.textContent = t('save')
        save.style.padding = '5px 16px'
        save.style.borderRadius = '6px'
        save.style.border = '1px solid currentColor'
        save.style.background = 'transparent'
        save.style.color = 'inherit'
        save.style.cursor = 'pointer'
        save.style.font = 'inherit'
        var status = document.createElement('span')
        status.style.fontSize = '12px'
        status.style.opacity = '0.7'
        actions.appendChild(save)
        actions.appendChild(status)
        host.appendChild(actions)

        var draft = {
          unitNod: pluginSettings.unitNod,
          unitTurn: pluginSettings.unitTurn,
          voiceShortcut: pluginSettings.voiceShortcut,
          cursorHighlight: pluginSettings.cursorHighlight !== false,
          debounceMs: pluginSettings.debounceMs ?? 200,
          requireHeadOrbit: pluginSettings.requireHeadOrbit !== false,
          language: pluginSettings.language || 'auto',
        }

        function fill(payload) {
          if (!payload || !payload.values) return
          var langBefore = LANG
          pluginSettings = mergePluginSettings(pluginSettings, payload.values, payload.app, payload.system)
          applyPreferredLanguage()
          draft.language = pluginSettings.language || 'auto'
          langSelect.value = draft.language
          if (LANG !== langBefore) {
            rerenderSettings()
            return
          }
          draft.unitNod = pluginSettings.unitNod
          draft.unitTurn = pluginSettings.unitTurn
          draft.voiceShortcut = pluginSettings.voiceShortcut
          draft.cursorHighlight = pluginSettings.cursorHighlight !== false
          draft.debounceMs = pluginSettings.debounceMs ?? 200
          draft.requireHeadOrbit = pluginSettings.requireHeadOrbit !== false
          nod.set(fallbackNod())
          turn.set(fallbackTurn())
          var radios = modeWrap.querySelectorAll('input[type="radio"]')
          for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === pluginSettings.voiceShortcut
          highlight.checked = draft.cursorHighlight
          debounce.value = String(draft.debounceMs)
          requireOnline.checked = draft.requireHeadOrbit
          var appNod = pluginSettings.app && pluginSettings.app.unitNod
          var appTurn = pluginSettings.app && pluginSettings.app.unitTurn
          appLine.textContent =
            appNod || appTurn
              ? t('appCurrent').replace('%s', appNod ? appNod + '°' : 'auto').replace('%s', appTurn ? appTurn + '°' : 'auto')
              : 'App 当前幅度未知（戴上耳机连上后才会报上来）'
        }

        save.addEventListener('click', function () {
          save.disabled = true
          status.textContent = t('saving')
          fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(draft),
          })
            .then(function (res) {
              return res.ok ? res.json() : null
            })
            .then(function (payload) {
              if (payload === null) {
                status.textContent = t('saveFailed')
                return
              }
              var langBefore = LANG
              pluginSettings = mergePluginSettings(pluginSettings, payload.values, payload.app, payload.system)
              applyPreferredLanguage()
              draft.language = pluginSettings.language || 'auto'
              langSelect.value = draft.language
              if (LANG !== langBefore) {
                rerenderSettings()
                return
              }
              status.textContent = t('saved')
              window.setTimeout(function () {
                status.textContent = ''
              }, 2500)
            })
            .catch(function () {
              status.textContent = t('saveFailedOffline')
            })
            .then(function () {
              save.disabled = false
            })
        })

        fetch(SETTINGS_URL, { cache: 'no-store' })
          .then(function (res) {
            return res.ok ? res.json() : null
          })
          .then(fill)
          .catch(function () {
            appLine.textContent = t('readFailed')
          })

        return function () {
          if (motionTimer !== null) window.clearTimeout(motionTimer)
          motionTimer = null
          host.textContent = ''
        }
      }

      /** 拉一次设置：语音快捷键、高亮开关这些在挂载后就要立刻生效 */
      function loadPluginSettings() {
        fetch(SETTINGS_URL, { cache: 'no-store' })
          .then(function (res) {
            return res.ok ? res.json() : null
          })
          .then(function (payload) {
            if (stopped || payload === null || payload.values === undefined) return
            pluginSettings = mergePluginSettings(pluginSettings, payload.values, payload.app, payload.system)
            applyPreferredLanguage()
            log('settings loaded: shortcut=' + pluginSettings.voiceShortcut + ' highlight=' + pluginSettings.cursorHighlight + ' lang=' + LANG)
          })
          .catch(function () {
            /* 静默：拉不到就用默认值 */
          })
      }

      function mergePluginSettings(current, values, app, system) {
        var next = {
          unitNod: values.unitNod ?? null,
          unitTurn: values.unitTurn ?? null,
          voiceShortcut: values.voiceShortcut || 'arrows',
          cursorHighlight: values.cursorHighlight !== false,
          debounceMs: values.debounceMs ?? null,
          requireHeadOrbit: values.requireHeadOrbit ?? null,
          language: values.language || 'auto',
          system: system || current.system || { language: null },
          app: app || current.app || { unitNod: null, unitTurn: null },
        }
        return next
      }

      /** 设置页的 React 壳：只给一个容器，表单全在 mountSettingsPage 里 */
      function AirpodSettingsPage() {
        var host = react.useRef(null)
        var bump = react.useState(0)
        var setBump = bump[1]
        react.useEffect(function () {
          rerenderSettings = function () {
            setBump(function (n) {
              return n + 1
            })
          }
          var node = host.current
          if (!node) return undefined
          return mountSettingsPage(node)
        }, [bump[0]])
        return react.createElement('div', { ref: host })
      }

      function teardown() {
        stopped = true
        if (typeof disposeSettingsSection === 'function') {
          try {
            disposeSettingsSection()
          } catch (_) {
            /* ignore */
          }
          disposeSettingsSection = null
        }
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
      loadPluginSettings()
      if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
        try {
          disposeSettingsSection = ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'airpod-control',
                order: 60,
                label: function () {
                  // 侧栏文案在渲染时才求值：顺手把语言再对一次，免得设置还没拉回来就先画成英文
                  applyPreferredLanguage()
                  return t('sectionTitle')
                },
              },
              AirpodSettingsPage,
            )
          })
        } catch (err) {
          warn('settings section registration failed', err)
        }
      }
      log('mounted')
      // 给宿主留一句「我跑起来了」：没有这条，出问题时分不清是半区没加载还是没触发
      reportClientState(languageChanged ? 'boot-language' : 'boot')
    }

    exports.name = 'dsh-airpod-control'
    exports.inject = ['uiSession', 'slots']
    exports.apply = apply

    return module.exports
  },
})
