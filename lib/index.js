/**
 * dsh-airpod-control —— 用头部手势回答 DSH 的权限许可（点头＝允许，摇头＝拒绝）。
 *
 * 结构：HeadOrbit（macOS 菜单栏 App）把识别到的 `nod` / `shake` POST 到宿主上的本插件，
 * 同一套手势既能回答**权限许可**（approval），也能回答**模型的提问**（ask_user_question）：
 * 插件注册成一个审批回答者（approval answerer）：**只有真有请求在等的时候**才认领这次手势，
 * 否则返回 undefined 交给下一个回答者 —— 页面上那两个按钮照旧能用，两者不抢。
 *
 * 端点（都挂在 /dsh-airpod-control 前缀下）：
 *   GET  /state    → { waiting, label, deadlineAt, ... }，HeadOrbit 靠它决定要不要发手势
 *   GET  /health   → 自检（只读，不回报 token）
 *   GET  /events   → 最近的事件流水（排查用，条数有上限）
 *   POST /gesture  → { gesture: "nod" | "shake", requestId? } 真正的答案（带 requestId 表示网页卡片上点的）
 *   POST /answer   → { decision: "allow" | "reject" } 没有耳机时的等价入口（测试 / 兜底）
 *
 * 安全性（值得说清楚：这是从本机网络去改变一次授权决定）：
 *   - 不自己开端口：复用宿主已有的 webServer 路由，因此天然只听 127.0.0.1。
 *   - 必须有共享密钥：`token` 为空时插件完全不认领任何请求，并且要求 `X-HeadOrbit-Token`，
 *     所以本机别的进程即使能访问这个端口也伪造不了答案。
 *   - 只回答「正在等待中的那一次请求」：过期的、没有请求在等的、手势与映射不符的，
 *     一律忽略或拒绝；一次请求只会被结算一次。
 *   - 没有回答者时 DSH 本来就会 fail closed，本插件不改变这一点。
 */

const ROUTE_BASE = '/dsh-airpod-control'
const STATE_ROUTE = `${ROUTE_BASE}/state`
const HEALTH_ROUTE = `${ROUTE_BASE}/health`
const EVENTS_ROUTE = `${ROUTE_BASE}/events`
const GESTURE_ROUTE = `${ROUTE_BASE}/gesture`
const ANSWER_ROUTE = `${ROUTE_BASE}/answer`
/** 免 token 的只读路由：浏览器里的插件半区靠它收掉「已经用手势答过」的卡片 */
const DECISION_ROUTE = `${ROUTE_BASE}/last-decision`
/** 免 token 的只读路由：只回「当前光标在第几项、那一项叫什么」，不含题目内容 */
const CURSOR_ROUTE = `${ROUTE_BASE}/cursor`
const SHORTCUT_ROUTE = `${ROUTE_BASE}/shortcut`
/** 自动安装：GET 看状态，POST 一键下载/安装/配置/启动 */
const SETUP_ROUTE = `${ROUTE_BASE}/setup`
/** 设置页读写的偏好：只放「手感」字段，不含 token */
const SETTINGS_ROUTE = `${ROUTE_BASE}/settings`
const MOTION_ROUTE = `${ROUTE_BASE}/motion`
/** 浏览器半区的自述：它到底跑起来没有、现在用哪种语言、上一次说了什么 */
const CLIENT_STATE_ROUTE = `${ROUTE_BASE}/client-state`

const PLUGIN_VERSION = '0.3.0'

/**
 * 系统界面语言（'zh' | 'en' | null）。
 *
 * 为什么要绕到系统层来问：这台机器上 `Intl.DateTimeFormat().resolvedOptions().locale`
 * 和 Electron 里的 `navigator.language` 一律是 en-US，跟着它们判断会让中文系统的用户
 * 看到英文界面（实测踩过）。macOS 的真实偏好在 `defaults read -g AppleLanguages`，
 * 其它平台看 LC_ALL / LANG；都问不到就返回 null，由前端自己猜。
 */
let cachedSystemLanguage
function systemLanguage() {
  if (cachedSystemLanguage !== undefined) return cachedSystemLanguage
  let raw = null
  try {
    if (process.platform === 'darwin') {
      const text = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2_000 })
      const first = /"([^"]+)"/.exec(text)
      if (first !== null) raw = first[1]
    }
  } catch {
    raw = null
  }
  if (raw === null) {
    const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
    if (env !== '') raw = env
  }
  cachedSystemLanguage = raw === null ? null : /^zh/i.test(raw) ? 'zh' : 'en'
  return cachedSystemLanguage
}
/** 只接受回环 Host，避免 DNS rebinding 之类的玩法（与 dsh-open-external 同一套判断） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const GESTURES = ['nod', 'shake']
/** 一直没人做手势时的兜底：到点就按「拒绝」结算，绝不让工具无限挂着 */
const DEFAULT_TIMEOUT_MS = 600_000
/** 提问没人理时的兜底：按「超时」结算，工具会返回 pending 而不是把这一轮卡死 */
const DEFAULT_QUESTION_TIMEOUT_MS = 600_000
/** 多道题时，选项多于这个数量就不认领（手势只能表达「首/末」两个方向） */
const MAX_GESTURE_OPTIONS = 3
/** 单道题可以放宽到「摇头切换、点头确认」能表达的范围 */
const MAX_CURSOR_OPTIONS = 8
/** 从选项文字猜「哪个是同意」用 */
const AFFIRMATIVE = ['是', '好', '确', '允许', '同意', '继续', '可以', 'yes', 'ok', 'okay', 'allow', 'approve', 'continue', 'proceed', 'accept']
const NEGATIVE = ['否', '不', '取消', '拒绝', '停止', '别', 'no', 'cancel', 'reject', 'deny', 'stop', 'abort', 'skip']
/** 手势到达时刻距离「做出动作」的容忍度 */
const DEFAULT_GESTURE_TTL_MS = 2_000
/** 两次手势之间的最小间隔，防止识别抖动一下就给两个答案 */
// 「摇两次切两项」要求手势间隔约 0.3–0.5s；600ms 会把第二次吞掉。一个动作只产生一次识别事件，
// 200ms 足够挡掉串扰，又不会吃掉连续手势。
const DEFAULT_DEBOUNCE_MS = 200
const DEFAULT_EVENT_LIMIT = 50
/** HeadOrbit 多久没轮询 /state 就当它不在线（它的轮询间隔是 0.75 秒） */
const DEFAULT_ALIVE_WINDOW_MS = 6_000
const MAX_BODY_BYTES = 16_384

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/** 参数只留一小段用于显示，超长截断 */
function describeParams(input, maxChars) {
  if (input === undefined || input === null) return ''
  let text
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    text = String(input)
  }
  if (typeof text !== 'string') text = String(text)
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** 选项文字命中同意/否定词表的位置，找不到给 -1 */
function matchByWords(options, words) {
  for (let i = 0; i < options.length; i += 1) {
    const label = String(options[i]?.label ?? '').toLowerCase()
    if (words.some((word) => label.includes(word))) return i
  }
  return -1
}

/** 一个问题里，点头 / 摇头 / 取消 各自对应哪个选项下标；-1 表示这个手势没有可选项 */
function gestureOptionIndexes(question, nodAllows) {
  const options = (question.options ?? []).map((option) => ({ ...option }))
  const none = { nod: -1, shake: -1, hasOptions: false }
  if (options.length === 0) return { ...none, options }

  const last = options.length - 1
  // ① 模型显式声明的审批选项最可信
  const approveIndex = options.findIndex((option) => option.label === question.intent?.approve)
  if (approveIndex !== -1) {
    const allowIndex = approveIndex
    // approve 在开头 → 点头选它、摇头选最后一项；在结尾 → 反过来
    const rejectIndex = approveIndex === 0 ? last : 0
    return {
      options,
      hasOptions: true,
      nod: nodAllows ? allowIndex : rejectIndex,
      shake: nodAllows ? rejectIndex : allowIndex,
    }
  }
  // ② 词表猜：第一项像同意就点头选它，否则像否定的那种留给摇头
  const nodIndex = matchByWords(options, AFFIRMATIVE)
  if (nodIndex !== -1) {
    const shakeIndex = matchByWords(options, NEGATIVE)
    return { options, hasOptions: true, nod: nodIndex, shake: shakeIndex === -1 ? last : shakeIndex }
  }
  // ③ 位置兜底：点头＝第一项，摇头＝最后一项（两者相同就只留点头）
  return { options, hasOptions: true, nod: nodAllows ? 0 : last, shake: nodAllows ? last : 0 }
}

/** 提问在 /state 和菜单栏里显示成一行 */
function questionLabel(questions, maxChars) {
  const first = questions[0]
  const title = String(first?.header ?? '') || String(first?.question ?? '')
  const more = questions.length > 1 ? ` (+${questions.length - 1})` : ''
  const text = `${title}${more}`
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

import { execFileSync } from 'node:child_process'
import { loadOrCreateTokenSync, runSetup, readBridgeConfig, appInstalled, appRunning, openMotionPane, writeEndpoint } from './installer.js'
import { loadUserSettings, mergeUserSettings, saveUserSettings, LIMITS, SHORTCUT_MODES } from './user-settings.js'

export default {
  name: 'dsh-airpod-control',

  /**
   * @param ctx - profile 作用域上下文
   * @param config - 入口配置：enabled / token / 各超时 / nodAllows
   */
  apply(ctx, config = {}) {
    const settings = {
      enabled: config.enabled === true,
      token: typeof config.token === 'string' ? config.token.trim() : '',
      gestureTtlMs: clampInt(config.gestureTtlMs, DEFAULT_GESTURE_TTL_MS, 200, 30_000),
      debounceMs: clampInt(config.debounceMs, DEFAULT_DEBOUNCE_MS, 0, 5_000),
      timeoutMs: clampInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 3_600_000),
      nodAllows: config.nodAllows !== false,
      // 'auto'：只认领手势能完整回答的提问（选项 ≤3、非多选）；'off'：完全不接提问
      claimQuestions: config.claimQuestions === 'off' ? 'off' : 'auto',
      questionTimeoutMs: clampInt(config.questionTimeoutMs, DEFAULT_QUESTION_TIMEOUT_MS, 1_000, 3_600_000),
      // 选项 >2 的对单题：点头 N 次＝选第 N 项，最后一次点头后等这么久落定
      yesLabel: typeof config.yesLabel === 'string' && config.yesLabel.trim() !== '' ? config.yesLabel.trim() : '是',
      noLabel: typeof config.noLabel === 'string' && config.noLabel.trim() !== '' ? config.noLabel.trim() : '否',
      logHeadlines: config.logHeadlines !== false,
      eventLimit: clampInt(config.eventLimit, DEFAULT_EVENT_LIMIT, 10, 500),
      maxParamsChars: clampInt(config.maxParamsChars, 500, 0, 4_000),
      // HeadOrbit 每隔 0.75 秒轮询一次 /state；这么久没动静就认为它不在线，
      // 于是所有请求原样交给网页卡片 —— 没戴耳机时行为和你没装这个插件一样。
      aliveWindowMs: clampInt(config.aliveWindowMs, DEFAULT_ALIVE_WINDOW_MS, 1_000, 120_000),
      // false = 不看心跳，永远抢答。只在「想用 curl 验一遍」或「HeadOrbit 还没装好」时开
      requireHeadOrbit: config.requireHeadOrbit !== false,
    }

    /**
     * 设置页里改过的偏好覆盖安装配置里的同名项。
     * 幅度（unitNod/unitTurn）为 null 表示「没设过」——那就不覆盖 App 自己
     * 按用户阈值算出来的值，/state 里以 null 下发。
     */
    let userSettings = loadUserSettings()
    /** App 自己报上来的幅度（GET /state?nod=12&turn=19 的查询参数），只用于设置页显示 */
    let appUnits = { unitNod: null, unitTurn: null }
    /** App 最近一次上报的实时幅度（度），给设置页画「够不够阈值」的条 */
    let lastMotion = { pitch: 0, yaw: 0, at: 0 }
    // 设置页清空某项时要退回安装配置里的值，所以先留一份基准
    const baseSettings = {
      debounceMs: settings.debounceMs,
      requireHeadOrbit: settings.requireHeadOrbit,
    }
    if (userSettings.debounceMs !== null) settings.debounceMs = userSettings.debounceMs
    if (userSettings.requireHeadOrbit !== null) settings.requireHeadOrbit = userSettings.requireHeadOrbit

    /**
     * 共享 token：配置里写了就用配置里的；没写就自动生成一份落到
     * ~/.dsh-airpod-control/token。安装器会把同一个值写进 HeadOrbit，用户不用手填。
     * 必须同步拿到——下面注册回答者时就要判断「有没有 token」，没 token 就不认领。
     */
    let token = settings.token
    if (token === '') {
      try {
        token = loadOrCreateTokenSync()
      } catch {
        token = ''
      }
    }

    // 关着的时候什么都不注册：不路由、不接审批，和没装这个插件完全一样
    if (!settings.enabled) return

    const events = []
    const disposers = []
    /** 当前等着被手势回答的那一次**审批**；null 表示没有 */
    let pendingApproval = null
    /** 当前等着被手势回答的那一次**提问**；null 表示没有 */
    let pendingQuestion = null
    /** 网页卡片点选时带回来的请求标识：只有 id 对得上才认 */
    let requestSeq = 0
    let lastGestureAt = 0
    let lastGesture = null
    let answered = 0
    let ignored = 0
    let hasApprovalAnswerer = false
    let hasQuestionAnswerer = false
    /** HeadOrbit 最近一次轮询 /state 的时刻；0 表示它从没来过 */
    let lastStateAt = 0
    /**
     * 最近一次由「手势 / 本机接口」做出的决定。浏览器里的插件半区靠它把已经失效的
     * 卡片收掉：宿主被别的回答者结算后，不会去 abort 远端那份展示。
     */
    let lastDecision = null
// 浏览器半区的 ⌥Space 快捷键打到哪一步了——真机排查用，只存事件名和时间
const shortcutEvents = []
/**
 * 浏览器半区的自述：最近一次心跳/说话的时间、语言、说了什么、走的哪条通道。
 * 全是「有没有跑起来」的诊断数据，不参与任何判断。
 */
const clientState = { at: null, bootAt: null, boots: 0, notes: 0, lang: null, kind: null, text: null, channel: null, geom: null }
    let decisionSeq = 0
    /** 最近一次 /setup 的结果，以及它是不是正在跑（同时只允许一个） */
    let lastSetup = null
    let setupRunning = false

    /** HeadOrbit 在线吗？只有它在轮询，我们才去抢答；否则一切照旧走网页卡片 */
    function headOrbitAlive() {
      if (!settings.requireHeadOrbit) return true
      return lastStateAt !== 0 && Date.now() - lastStateAt < settings.aliveWindowMs
    }

    /**
     * 让「头部手势」和「网页卡片」赛跑，谁先给出真答案算谁的。
     *
     * 为什么不是二选一：插件抢答（waterfall 里返回结果）会让网页那张卡片不再渲染，
     * 那样没戴耳机的人就只剩「等超时自动拒绝」一条路。所以两边都留着 ——
     * 我们照常认领，同时调用 next() 让网页也把卡片画出来。
     *
     * 注意 `unavailable` 的含义是「这一路没有回答者」，不是「用户拒绝」，
     * 所以网页回来 unavailable 时不能当作结果，要继续等手势。
     */
    function raceWithBrowser(gestureOutcome, browserOutcome, onBrowserWin) {
      const pending = new Promise(() => {})
      const browser = Promise.resolve(browserOutcome).then(
        (outcome) => {
          if (outcome === undefined || outcome === null || outcome === 'unavailable') return pending
          onBrowserWin?.(String(outcome))
          return outcome
        },
        () => pending,
      )
      return Promise.race([gestureOutcome, browser])
    }

    function record(kind, detail = {}) {
      events.push({ at: new Date().toISOString(), kind, ...detail })
      if (events.length > settings.eventLimit) events.splice(0, events.length - settings.eventLimit)
      if (!settings.logHeadlines) return
      const summary = detail.label ?? detail.reason ?? detail.gesture ?? detail.outcome ?? ''
      // 日志绝不能让「答题」失败：ctx.logger 在某些上下文里可能不存在（属性访问会抛），
      // 或者宿主换了 logger 实现。所以这里整块吞掉异常。
      try {
        ctx.logger?.info?.(`[dsh-airpod-control] ${kind}${summary === '' ? '' : ` ${summary}`}`)
      } catch {
        /* 记不上就算了 */
      }
    }

    function settleApproval(outcome, why) {
      const p = pendingApproval
      if (p === null) return false
      pendingApproval = null
      if (outcome === 'allowed-once' || outcome === 'rejected') answered += 1
      else ignored += 1
      decisionSeq += 1
      lastDecision = {
        seq: decisionSeq,
        at: Date.now(),
        kind: 'approval',
        outcome,
        reason: why,
        // 审批没有「选项」：网页半区据此说「点头 → 允许」而不是「选了某一项」
        option: null,
        toolName: p.entry.toolName,
        callId: typeof p.entry.callId === 'string' ? p.entry.callId : null,
      }
      record('answered', { label: p.entry.toolName, outcome, reason: why })
      p.resolve(outcome)
      return true
    }

    /** 提问链路上的错误：名字和 code 必须和宿主认识的 UserQuestionError 对齐 */
    function askError(code, message) {
      const err = new Error(message)
      err.name = 'UserQuestionError'
      err.code = code
      return err
    }

    /** 包一个「已被标记处理」的 rejection：有的路径（插件卸载）没人 await，裸 reject 会变成 unhandledRejection */
    function rejected(err) {
      const promise = Promise.reject(err)
      promise.catch(() => {})
      return promise
    }

    /** 结算一次提问；failed 不为空表示这个手势没法回答它（比如 id 过期） */
    function settleQuestion(answer, why, failed, option) {
      const p = pendingQuestion
      if (p === null) return { ok: false, reason: 'nothing is waiting for a decision' }
      if (failed !== undefined) return { ok: false, reason: failed }
      pendingQuestion = null
      if (p.timer != null) clearTimeout(p.timer)
      answered += 1
      decisionSeq += 1
      lastDecision = {
        seq: decisionSeq,
        at: Date.now(),
        kind: 'question',
        outcome: 'answered',
        reason: why,
        // 网页半区用它弹一句「刚才选的是哪个」——卡片收得太快，光看高亮看不到结果
        option: typeof option === 'string' ? option : null,
        toolName: p.entry.label,
        callId: null,
      }
      record('answered', { label: p.entry.label, outcome: 'answered', reason: why })
      p.resolve({ answers: answer })
      return { ok: true }
    }

    // 卸载时把挂着的请求结算掉，别留一个永远不返回的 Promise
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 卸载期清理失败不影响别的 disposer */
        }
      }
      disposers.length = 0
      settleApproval('unavailable', 'plugin unloaded')
    })

    // ── 审批回答者 ──────────────────────────────────────────────────────────
    // 等 approval 服务就位再注册（它属于宿主基础组合，通常已经在）。
    if (token !== '') ctx.inject(['approval'], () => {
      hasApprovalAnswerer = true
      ctx.effect(() => () => {
        hasApprovalAnswerer = false
        settleApproval('unavailable', 'approval service went away')
      })

      ctx.on('approval/request', (req, next) => {
        if (pendingApproval !== null) {
          record('ignored', { reason: 'a decision is already waiting' })
          return next()
        }
        // HeadOrbit 不在线（没开 App / 没戴耳机 / 没在追踪）：一行都不碰，网页卡片照旧
        if (!headOrbitAlive()) {
          record('passed', { reason: 'HeadOrbit 不在线，交给网页卡片' })
          return next()
        }

        const session = req?.agent?.session
        // 网页卡片会优先显示 displayReason：顺手把「点头=允许 / 摇头=拒绝」印在卡片上，
        // 免得戴耳机的人不知道该怎么答。已经有自己的说明就不覆盖。
        if (req !== null && typeof req === 'object' && req.displayReason === undefined) {
          try {
            req.displayReason = '点头＝允许 / 摇头＝拒绝（点头/摇头一次即可，也可以直接点这里的按钮）'
          } catch {
            // 请求对象被冻结也无所谓：卡片少一行提示而已
          }
        }

        const entry = {
          toolName: typeof req?.toolName === 'string' ? req.toolName : 'unknown',
          callId: req?.callId,
          reason: typeof req?.reason === 'string' ? req.reason : undefined,
          params: describeParams(req?.input, settings.maxParamsChars),
          sessionId: typeof session?.id === 'string' ? session.id : undefined,
          openedAt: Date.now(),
          deadlineAt: Date.now() + settings.timeoutMs,
        }

        record('asked', { label: entry.toolName, deadlineAt: entry.deadlineAt })

        const outcome = new Promise((resolve) => {
          pendingApproval = { entry, resolve, timer: null }
          pendingApproval.timer = setTimeout(() => {
            settleApproval('rejected', `no head gesture within ${settings.timeoutMs} ms`)
          }, settings.timeoutMs)
          // 人中止了这一轮（Esc / 停止按钮）：别把一个已经作废的请求继续挂着
          req?.signal?.addEventListener?.('abort', () => settleApproval('cancelled', 'the request was aborted'), {
            once: true,
          })
        })

        // 卡片同时留着：用户在网页上点「允许/拒绝」和做一个手势，谁先到算谁的
        return raceWithBrowser(outcome, next(), (why) => {
          if (pendingApproval === null) return
          const p = pendingApproval
          pendingApproval = null
          clearPendingTimer(p)
          ignored += 1
          record('passed', { label: entry.toolName, reason: `网页卡片先答了：${why}` })
        })
      }, { prepend: true })
    })

    // ── 提问回答者 ──────────────────────────────────────────────────────────
    // 契约（dsh-tool-ask-user → ctx.userQuestions.ask）：
    //   请求 { questions, agent?, signal, wait? }，questions[i] = { id, question, header?, options?, multiSelect?, intent? }
    //   应答 { answers: [{ id, selected: string[], custom? }] }，与 questions 一一对应
    // 挂起的提问一定要被结算，否则模型那一轮永远等不到工具结果 —— 所以有超时兜底，
    // 超时按 ASK_TIMED_OUT 抛，工具会返回 pending（不是「跳过」），用户之后还能用卡片补答。
    if (token !== '' && settings.claimQuestions !== 'off') ctx.inject(['userQuestions'], () => {
      hasQuestionAnswerer = true
      ctx.effect(() => () => {
        hasQuestionAnswerer = false
        if (pendingQuestion !== null) {
          const p = pendingQuestion
          pendingQuestion = null
          if (p.timer != null) clearTimeout(p.timer)
          p.resolve(rejected(askError('ASK_CANCELLED', 'the plugin unloaded before the user answered')))
        }
      })

      ctx.on('user-questions/request', (req, next) => {
        const questions = Array.isArray(req?.questions) ? req.questions : null
        if (questions === null || questions.length === 0) return next()

        const claim = claimQuestion(questions, settings)
        if (claim.error !== undefined) {
          record('ignored', { reason: claim.error })
          return next()
        }
        if (pendingQuestion !== null) {
          record('ignored', { reason: 'a question is already waiting' })
          return next()
        }
        // 同理：HeadOrbit 不在线就完全按原来的路子走（网页卡片）
        if (!headOrbitAlive()) {
          record('passed', { reason: 'HeadOrbit 不在线，交给网页卡片' })
          return next()
        }

        const openedAt = Date.now()
        const requestId = `q${(requestSeq += 1)}`
        const entry = {
          requestId,
          questions,
          agent: req?.agent,
          wait: req?.wait,
          openedAt,
          deadlineAt: openedAt + settings.questionTimeoutMs,
          label: questionLabel(questions, 120),
        }

        record('asked-question', { label: entry.label, count: questions.length })

        const answered = new Promise((resolve) => {
          const firstQuestion = entry.questions[0]
          pendingQuestion = {
            entry,
            resolve,
            timer: null,
            cursor: firstQuestion?.options?.length ? initialCursor(firstQuestion) : 0,
          }
          pendingQuestion.timer = setTimeout(() => {
            const p = pendingQuestion
            if (p === null) return
            pendingQuestion = null
            ignored += 1
            record('answered', { label: entry.label, outcome: 'timed-out', reason: 'no head gesture in time' })
            // 名字与 code 要和 UserQuestionError 一致：askTimed 才会把它当成超时，返回 pending
            p.resolve(rejected(askError('ASK_TIMED_OUT', 'ask_user_question timed out before the user answered with a head gesture')))
          }, settings.questionTimeoutMs)
          req?.signal?.addEventListener?.('abort', () => {
            const p = pendingQuestion
            if (p === null) return
            pendingQuestion = null
            if (p.timer != null) clearTimeout(p.timer)
            ignored += 1
            record('answered', { label: entry.label, outcome: 'cancelled', reason: 'the request was aborted' })
            // 千万不能 resolve(undefined)：宿主会把返回值当答案去读 .answers 然后炸掉（真机踩过）
            p.resolve(rejected(askError('ASK_CANCELLED', 'the question was dismissed before a head gesture answered it')))
          }, { once: true })
        })

        const raced = raceWithBrowser(answered, next(), (why) => {
          if (pendingQuestion === null) return
          const p = pendingQuestion
          pendingQuestion = null
          clearPendingTimer(p)
          ignored += 1
          record('passed', { label: entry.label, reason: `网页卡片先答了：${why}` })
        })
        // 交回宿主的必须是「答案对象」或一个明确的错误；undefined 会被当成答案直接读 .answers
        return raced.then((value) => {
          if (value !== undefined && value !== null) return value
          throw askError('ASK_CANCELLED', 'the question ended without an answer')
        })
      }, { prepend: true })
    })

    // ── 手势 → 决定 ────────────────────────────────────────────────────────
    function clearPendingTimer(p) {
      if (p?.timer != null) clearTimeout(p.timer)
    }

    /** 手势总入口：先回答提问（它是动作题），没提问时才当作许可的答案 */
    function decide(gesture, ttlMs, requestId) {
      if (!GESTURES.includes(gesture)) {
        return { status: 400, body: { accepted: false, reason: `unknown gesture "${gesture}"` } }
      }

      const at = Date.now()
      if (requestId === undefined && at - lastGestureAt < settings.debounceMs) {
        return {
          status: 429,
          body: { accepted: false, reason: 'debounced', waiting: pendingApproval !== null || pendingQuestion !== null },
        }
      }
      if (requestId === undefined) {
        lastGestureAt = at
        lastGesture = { gesture, at: new Date(at).toISOString() }
      }

      if (pendingQuestion !== null) return decideQuestion(gesture, requestId, at)
      if (pendingApproval !== null) return decideApproval(gesture, ttlMs, at)
      return { status: 200, body: { accepted: false, reason: 'nothing is waiting for a decision' } }
    }

    /** 许可：点头＝允许、摇头＝拒绝（nodAllows 取反即交换） */
    function decideApproval(gesture, ttlMs, at) {
      const p = pendingApproval
      const ttl = clampInt(ttlMs, settings.gestureTtlMs, 0, 30_000)
      if (ttl > 0 && at - p.entry.openedAt > settings.timeoutMs + ttl) {
        return { status: 200, body: { accepted: false, reason: 'stale gesture' } }
      }

      const allowGesture = settings.nodAllows ? 'nod' : 'shake'
      const rejectGesture = settings.nodAllows ? 'shake' : 'nod'
      clearPendingTimer(p)

      if (gesture === rejectGesture) {
        settleApproval('rejected', rejectGesture === 'shake' ? 'you shook your head' : 'you nodded')
        return { status: 200, body: { accepted: true, decision: 'rejected' } }
      }
      if (gesture !== allowGesture) {
        return { status: 200, body: { accepted: false, reason: 'not the mapped gesture' } }
      }
      settleApproval('allowed-once', allowGesture === 'nod' ? 'you nodded' : 'you shook your head')
      return { status: 200, body: { accepted: true, decision: 'allowed-once' } }
    }

    /** 提问：点头＝是/继续、摇头＝否/取消；多选题里点头＝全选、摇头＝全不选 */
    function decideQuestion(gesture, requestId, at) {
      const p = pendingQuestion
      if (p === null) {
        // 带 requestId 的是网页卡片来的：它手里的那张卡已经过期了，别让它误答下一个问题
        if (requestId === undefined) {
          return { status: 200, body: { accepted: false, reason: 'nothing is waiting for a decision' } }
        }
        return { status: 409, body: { accepted: false, stale: true, reason: 'this question is no longer waiting' } }
      }
      if (requestId !== undefined && requestId !== p.entry.requestId) {
        return { status: 409, body: { accepted: false, stale: true, reason: 'this question is no longer waiting' } }
      }
      if (requestId === undefined) {
        const ttl = settings.gestureTtlMs
        if (ttl > 0 && at - p.entry.openedAt > settings.questionTimeoutMs + ttl) {
          return { status: 200, body: { accepted: false, reason: 'stale gesture' } }
        }
      }

      const cursorQuestion = cursorModeFor(p.entry.questions)
      if (cursorQuestion !== undefined) return decideCursorQuestion(p, cursorQuestion, gesture)

      const plan = mapGestureToAnswer(p.entry.questions, gesture, settings)
      if (plan.error !== undefined) {
        return { status: 200, body: { accepted: false, reason: plan.error } }
      }

      const settled = settleQuestion(plan.answers, plan.why, undefined, optionFromAnswers(plan.answers))
      if (!settled.ok) return { status: 409, body: { accepted: false, stale: true, reason: settled.reason } }
      return { status: 200, body: { accepted: true, decision: plan.decisionLabel, answers: plan.answers } }
    }

    /** 网页卡片（兜底交互）用决策词回答许可；带 requestId 表示回答的是一次提问 */
    function answer(decision, requestId) {
      // 没有耳机时的等价入口，除了点头/摇头，还能直接点名某一项（多选的第一项这种手势表达不了的情况）
      const select = typeof decision === 'string' && /^select:\d+$/.test(decision)
        ? Number(decision.slice('select:'.length))
        : undefined
      if (decision !== 'allow' && decision !== 'reject' && select === undefined) {
        return { status: 400, body: { accepted: false, reason: `unknown decision "${decision}"` } }
      }
      if (requestId !== undefined || select !== undefined) {
        const plan = planFromDecision(pendingQuestion, select === undefined ? decision : 'select', settings, select)
        if (plan.error !== undefined) {
          const stale = pendingQuestion === null
          return { status: stale ? 409 : 400, body: { accepted: false, stale, reason: plan.error } }
        }
        const settled = settleQuestion(plan.answers, plan.why, undefined, optionFromAnswers(plan.answers))
        if (!settled.ok) return { status: 409, body: { accepted: false, stale: true, reason: settled.reason } }
        return { status: 200, body: { accepted: true, decision: plan.decisionLabel, answers: plan.answers } }
      }

      if (pendingApproval === null) {
        return { status: 200, body: { accepted: false, reason: 'nothing is waiting for a decision' } }
      }
      clearPendingTimer(pendingApproval)
      if (decision === 'allow') {
        settleApproval('allowed-once', 'answered through the local endpoint')
        return { status: 200, body: { accepted: true, decision: 'allowed-once' } }
      }
      settleApproval('rejected', 'answered through the local endpoint')
      return { status: 200, body: { accepted: true, decision: 'rejected' } }
    }

    // ── 提问 → 答案 ────────────────────────────────────────────────────────
    /**
     * 一批提问能不能被手势完整回答：每个问题要么有 ≤3 个选项，要么是自由文本；
     * 多选题可以（点头＝全选、摇头＝全不选）。任何一道答不了就不认领，交给网页卡片。
     */
    function claimQuestion(questions, cfg) {
      for (const question of questions) {
        const options = question?.options ?? []
        if (options.length === 0) {
          if (typeof question?.question !== 'string' || question.question.trim() === '') {
            return { error: 'a question has neither options nor text to answer' }
          }
          continue
        }
        if (options.length > MAX_GESTURE_OPTIONS && cursorModeFor(questions) !== question) {
          return { error: `a question offers ${options.length} options; head gestures cover at most ${MAX_GESTURE_OPTIONS}` }
        }
        if (options.length > MAX_CURSOR_OPTIONS) {
          return { error: `a question offers ${options.length} options; shake-to-switch covers at most ${MAX_CURSOR_OPTIONS}` }
        }
        if (question?.multiSelect === true && options.length === 0) {
          return { error: 'a multi-select question has no options to toggle' }
        }
      }
      if (cfg.claimQuestions === 'off') return { error: 'question answering is turned off' }
      return {}
    }

    /**
     * 「摇头切换、点头确认」模式：只在「单道题、非多选、选项 3..MAX_CURSOR_OPTIONS」时启用。
     * 两个选项的题不走这里 —— 那种题点头＝同意、摇头＝不同意，和审批保持同一套方向语义。
     */
    function cursorModeFor(questions) {
      if (questions.length !== 1) return undefined
      const question = questions[0]
      if (question?.multiSelect === true) return undefined
      const options = question?.options ?? []
      if (options.length <= 2 || options.length > MAX_CURSOR_OPTIONS) return undefined
      return question
    }

    /** 光标初始位置：计划审查题从「同意」那一项开始，其它从第一项开始 */
    function initialCursor(question) {
      const options = question.options ?? []
      const approve = question.intent?.approve
      const index = typeof approve === 'string' ? options.findIndex((o) => o.label === approve) : -1
      return index >= 0 ? index : 0
    }

    /**
     * 光标模式下的手势：摇头＝切到下一项（循环），点头＝确认当前高亮项。
     * 不做自动落定 —— 用户点头之前问题一直挂着，由 questionTimeoutMs 兜底。
     */
    function decideCursorQuestion(p, question, gesture) {
      const options = question.options ?? []
      const total = options.length
      if (p.cursor == null) p.cursor = initialCursor(question)

      if (gesture === 'shake') {
        p.cursor = (p.cursor + 1) % total
        const selectedLabel = options[p.cursor].label
        record('question-cursor', { label: question.header, index: p.cursor + 1, total, option: selectedLabel })
        return {
          status: 200,
          body: {
            accepted: true,
            pending: true,
            cursor: p.cursor,
            optionCount: total,
            selectedLabel,
            hint: `${p.cursor + 1}/${total} ${selectedLabel}（摇头切换，点头确认）`,
          },
        }
      }
      if (gesture === 'nod') {
        const picked = options[p.cursor]
        const answers = [{ id: question.id, selected: [picked.label] }]
        const settled = settleQuestion(answers, `you nodded on option ${p.cursor + 1} → ${picked.label}`, undefined, picked.label)
        if (!settled.ok) return { status: 409, body: { accepted: false, stale: true, reason: settled.reason } }
        return { status: 200, body: { accepted: true, decision: 'answer', answers, cursor: p.cursor } }
      }
      return { status: 200, body: { accepted: false, reason: 'not a mapped gesture' } }
    }

    /** 从一批答案里挑出「人话标签」，给网页半区弹一句「刚才选了什么」 */
function optionFromAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return null
  const selected = answers[0]?.selected
  if (!Array.isArray(selected) || selected.length === 0) return null
  return selected.length === 1 ? String(selected[0]) : selected.map(String).join(' / ')
}

/** 一次手势落成整批答案；任一问答不了就整体放弃（不做「答一半」的批次） */
    function mapGestureToAnswer(questions, gesture, cfg) {
      const answers = []
      for (const question of questions) {
        const plan = gestureOptionIndexes(question, cfg.nodAllows)
        const yes = gesture === (cfg.nodAllows ? 'nod' : 'shake')
        if (plan.hasOptions && plan.options.length > 0) {
          if (question.multiSelect === true) {
            answers.push({ id: question.id, selected: yes ? plan.options.map((option) => option.label) : [] })
            continue
          }
          const index = yes ? plan.nod : plan.shake
          if (index === -1) return { error: `a ${gesture} cannot answer question ${String(question.id)}` }
          answers.push({ id: question.id, selected: [plan.options[index].label] })
          continue
        }
        answers.push({ id: question.id, selected: [], custom: yes ? cfg.yesLabel : cfg.noLabel })
      }
      return { answers, why: gesture === 'nod' ? 'you nodded' : 'you shook your head', decisionLabel: gesture }
    }

    /** 网页卡片上的按钮（allow / reject）落成整批答案 */
    function planFromDecision(pendingQ, decision, cfg, select) {
      if (pendingQ === null) return { error: 'nothing is waiting for a decision' }

      // 直接点名选项：每一个问题都得是「有选项」的题，否则这层意思表达不出来
      if (select !== undefined) {
        const answers = []
        for (const question of pendingQ.entry.questions) {
          const plan = gestureOptionIndexes(question, cfg.nodAllows)
          if (!plan.hasOptions || plan.options.length === 0) {
            return { error: `question ${String(question.id)} has no options to select from` }
          }
          if (!Number.isInteger(select) || select < 0 || select >= plan.options.length) {
            return { error: `option ${String(select)} is out of range for question ${String(question.id)}` }
          }
          answers.push({ id: question.id, selected: [plan.options[select].label] })
        }
        return { answers, why: `you picked option ${String(select)}`, decisionLabel: `select:${String(select)}` }
      }

      if (decision !== 'allow' && decision !== 'reject') {
        return { error: `unknown decision "${String(decision)}"` }
      }
      return mapGestureToAnswer(pendingQ.entry.questions, decision === 'allow' ? 'nod' : 'shake', cfg)
    }

    // ── HTTP ────────────────────────────────────────────────────────────────
    function rejectionOf(req, isPublic = false) {
      const host = String(req.headers?.host ?? '')
      const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      if (!LOOPBACK_HOSTS.has(name)) return 403
      if (String(req.headers?.['sec-fetch-site'] ?? '') === 'cross-site') return 403
      // 免 token 的路由只读、不含会话内容（浏览器里的插件半区拿不到 token）
      if (isPublic) return null
      if (token === '') return 503
      if (req.headers?.['x-headorbit-token'] !== token) return 401
      return null
    }

    function send(res, status, payload) {
      if (res.headersSent) {
        res.end()
        return
      }
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      res.end(body)
    }

    async function readBody(req) {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) throw new Error('body too large')
        chunks.push(chunk)
      }
      if (chunks.length === 0) return {}
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('body must be an object')
      }
      return parsed
    }

    function register(route) {
      ctx.inject(['webServer'], (scope) => {
        disposers.push(
          scope.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: async (req, res) => {
              const code = rejectionOf(req, route.public === true)
              if (code !== null) {
                send(res, code, { error: code === 401 ? 'bad token' : code === 503 ? 'no token configured' : 'forbidden' })
                return
              }
              // 任何一次请求都是「宿主现在开在哪个端口」的实测：顺手刷新 endpoint.json，
              // 这样即使首次发布没赶上端口，也能在第一次对话后自愈。
              if (Date.now() - endpointPublishedAt > 10_000) publishEndpoint(portOf(req))
              try {
                await route.handler(req, res)
              } catch (err) {
                record('error', { reason: `${route.path}: ${String(err?.message ?? err)}` })
                send(res, 500, { error: 'internal error' })
              }
            },
          }),
        )
      })
    }

    /**
     * 把本次 DSH 的端口写到 ~/.dsh-airpod-control/endpoint.json：
     * HeadOrbit 每轮轮询都会读它，所以 DSH 重启换端口之后**不需要再改 App 配置**。
     * webServer 可能还没 listen（port 为 undefined），所以失败就退避重试。
     */
    let endpointPublishedAt = 0
    function publishEndpoint(port) {
      if (!writeEndpoint({ port, token, version: PLUGIN_VERSION })) return false
      endpointPublishedAt = Date.now()
      return true
    }
    /**
     * 首次发布：桌面端 webServer 的端口可能过好几十秒才定下来（Electron 先起壳、
     * 再起宿主），所以这里耐心重试 10 分钟，而不是试 15 秒就放弃——一放弃就死锁：
     * HeadOrbit 拿着旧端口的 endpoint.json 永远连不上，而刷新 endpoint.json 的
     * 时机又只在收到请求之后。
     */
    ctx.inject(['webServer'], (scope) => {
      const attempt = () => publishEndpoint(scope.webServer?.port)
      if (attempt()) return
      let left = 600
      const timer = setInterval(() => {
        left -= 1
        if (attempt() || left <= 0) clearInterval(timer)
      }, 1000)
      // 只是个便利文件的重试，别为了它把进程留在那儿不退出（CLI / 测试都受影响）
      if (typeof timer.unref === 'function') timer.unref()
      disposers.push(() => clearInterval(timer))
    })

    register({
      path: STATE_ROUTE,
      handler: (req, res) => {
        // 这次轮询本身就是「HeadOrbit 还活着」的证据（它每 0.75 秒来一次）
        const sinceLast = lastStateAt === 0 ? null : Date.now() - lastStateAt
        const wasAlive = headOrbitAlive()
        let query = null
        try {
          query = new URL(req.url ?? '', 'http://127.0.0.1').searchParams
        } catch {
          query = null
        }
        // 实时幅度：设置页画「现在点头有多大幅度、够不够阈值」的条
        const pitchRaw = query === null ? NaN : Number(query.get('pitch'))
        const yawRaw = query === null ? NaN : Number(query.get('yaw'))
        if (Number.isFinite(pitchRaw) && Number.isFinite(yawRaw)) {
          lastMotion = { pitch: Math.max(0, pitchRaw), yaw: Math.max(0, yawRaw), at: Date.now() }
        }
        // probe=1：App 没戴耳机时的慢速探测，只为了读设置——不能算作「在线心跳」，
        // 否则没耳机时插件也会抢答，把网页卡片堵住十分钟。
        const probe = query !== null && query.get('probe') === '1'
        if (!probe) lastStateAt = Date.now()
        // App 顺手报一下它现在用的幅度，设置页就能显示「App 当前：12°」
        if (query !== null) {
          const nod = Number(query.get('nod'))
          const turn = Number(query.get('turn'))
          appUnits = {
            unitNod: Number.isFinite(nod) && nod > 0 ? Math.round(nod) : appUnits.unitNod,
            unitTurn: Number.isFinite(turn) && turn > 0 ? Math.round(turn) : appUnits.unitTurn,
          }
        }
        const question = pendingQuestion === null ? null : {
          requestId: pendingQuestion.entry.requestId,
          label: pendingQuestion.entry.label,
          count: pendingQuestion.entry.questions.length,
          questions: pendingQuestion.entry.questions.map((item) => ({
            id: item.id,
            question: item.question,
            header: item.header,
            options: item.options,
            multiSelect: item.multiSelect === true,
          })),
          cursor: pendingQuestion.cursor ?? 0,
          selectedLabel:
            pendingQuestion.entry.questions[0]?.options?.[pendingQuestion.cursor ?? 0]?.label ?? null,
          openedAt: pendingQuestion.entry.openedAt,
          deadlineAt: pendingQuestion.entry.deadlineAt,
        }
        send(res, 200, {
          waiting: pendingApproval !== null || pendingQuestion !== null,
          kind: pendingQuestion !== null ? 'question' : pendingApproval !== null ? 'approval' : null,
          label: pendingQuestion !== null ? pendingQuestion.entry.label : pendingApproval?.entry.toolName,
          toolName: pendingApproval?.entry.toolName,
          reason: pendingApproval?.entry.reason,
          params: pendingApproval?.entry.params,
          question,
          openedAt: pendingQuestion?.entry.openedAt ?? pendingApproval?.entry.openedAt,
          deadlineAt: pendingQuestion?.entry.deadlineAt ?? pendingApproval?.entry.deadlineAt,
          canAnswer: (hasApprovalAnswerer || hasQuestionAnswerer) && token !== '',
          nodAllows: settings.nodAllows,
          // App 拿这两个值改识别门槛；null = 没在设置页里定过，用 App 自己算的
          gesture: { unitNod: userSettings.unitNod, unitTurn: userSettings.unitTurn },
          // HeadOrbit 的在线情况：alive 决定「要不要抢答」，lastSeenMs 是这次轮询之前隔了多久
          headOrbit: { alive: wasAlive, lastSeenMs: sinceLast, windowMs: settings.aliveWindowMs, required: settings.requireHeadOrbit },
          lastGesture,
          answered,
          ignored,
        })
      },
    })

    register({
      path: HEALTH_ROUTE,
      handler: (req, res) => {
        send(res, 200, {
          ok: true,
          plugin: 'dsh-airpod-control',
          version: PLUGIN_VERSION,
          hasToken: token !== '',
          hasApprovalAnswerer,
          hasQuestionAnswerer,
          headOrbitAlive: headOrbitAlive(),
          headOrbitWindowMs: settings.aliveWindowMs,
          requireHeadOrbit: settings.requireHeadOrbit,
          waiting: pendingApproval !== null || pendingQuestion !== null,
          waitingKind: pendingQuestion !== null ? 'question' : pendingApproval !== null ? 'approval' : null,
          answered,
          ignored,
        })
      },
    })

    register({
      path: EVENTS_ROUTE,
      handler: (req, res) => {
        send(res, 200, { events })
      },
    })

    register({
      path: DECISION_ROUTE,
      // 免 token：浏览器里的插件半区（同一个页面）靠它知道「这次请求已经被手势答过了」，
      // 好把那张已经失效的卡片收掉。只回一次决定的形状，不含任何会话内容。
      public: true,
      handler: (req, res) => {
        send(res, 200, {
          version: PLUGIN_VERSION,
          decision: lastDecision,
          waiting: pendingApproval !== null || pendingQuestion !== null,
          waitingKind: pendingQuestion !== null ? 'question' : pendingApproval !== null ? 'approval' : null,
        })
      },
    })

    register({
      path: CURSOR_ROUTE,
      // 免 token：浏览器半区靠它把「现在点头会选中哪一项」在卡片上圈出来。
      // 只回序号和那一项的文字，不返回题干和其它选项。
      public: true,
      handler: (req, res) => {
        const p = pendingQuestion
        const options = p?.entry?.questions?.[0]?.options ?? []
        const index = p?.cursor ?? 0
        // waiting 对提问和审批都为真：网页半区靠它决定「要不要把现在会按下的那个按钮圈出来」。
        // 之前只报了提问，审批卡片因此从来没被高亮过。
        send(res, 200, {
          version: PLUGIN_VERSION,
          waiting: p !== null || pendingApproval !== null,
          kind: p !== null ? 'question' : pendingApproval === null ? null : 'approval',
          index: p === null ? 0 : index + 1,
          total: options.length,
          option: p === null ? null : options[index]?.label ?? null,
          at: Date.now(),
        })
      },
    })

    register({
      path: MOTION_ROUTE,
      // 免 token：只回「此刻的点头/摇头幅度 + 当前阈值」，给设置页画实时条用。
      public: true,
      handler: (req, res) => {
        const nod = appUnits.unitNod
        const turn = appUnits.unitTurn
        send(res, 200, {
          version: PLUGIN_VERSION,
          pitch: Math.round(lastMotion.pitch * 10) / 10,
          yaw: Math.round(lastMotion.yaw * 10) / 10,
          at: lastMotion.at,
          alive: headOrbitAlive(),
          nod,
          turn,
        })
      },
    })

    register({
      path: CLIENT_STATE_ROUTE,
      // 免 token：浏览器半区自己的心跳。排查「卡片没高亮 / 气泡没出来」时，
      // 第一件事就是看这里——分不清「半区没加载」和「加载了但没触发」会白查很久。
      public: true,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          send(res, 200, { version: PLUGIN_VERSION, ...clientState })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: 'use GET or POST' })
          return
        }
        const body = await readBody(req).catch(() => ({}))
        const kind = typeof body.kind === 'string' ? body.kind.slice(0, 20) : ''
        clientState.at = Date.now()
        clientState.kind = kind
        if (typeof body.lang === 'string') clientState.lang = body.lang.slice(0, 8)
        if (typeof body.text === 'string') clientState.text = body.text.slice(0, 80)
        if (typeof body.channel === 'string') clientState.channel = body.channel.slice(0, 12)
        // 气泡定位用到的几何量：只在排查「气泡飘太高」时才有值
        if (typeof body.geom === 'string') clientState.geom = body.geom.slice(0, 120)
        if (kind === 'boot') {
          clientState.boots += 1
          clientState.bootAt = clientState.at
        }
        if (kind === 'note') clientState.notes += 1
        send(res, 200, { ok: true })
      },
    })

    register({
      path: SHORTCUT_ROUTE,
      // 免 token：这是浏览器半区自己上报的探针，只用来排查「按了 ⌥Space 但没反应」。
      // 只记事件名、原因和时间，不接收任何文本内容。
      public: true,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          send(res, 200, { version: PLUGIN_VERSION, events: shortcutEvents.slice(-10) })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: 'use GET or POST' })
          return
        }
        const body = await readBody(req).catch(() => ({}))
        const event = typeof body.event === 'string' ? body.event.slice(0, 40) : ''
        if (event === '') {
          send(res, 400, { error: 'event required' })
          return
        }
        shortcutEvents.push({
          event,
          reason: typeof body.reason === 'string' ? body.reason.slice(0, 80) : null,
          at: Date.now(),
        })
        if (shortcutEvents.length > 20) shortcutEvents.splice(0, shortcutEvents.length - 20)
        send(res, 200, { ok: true })
      },
    })

    // ── 一键安装 / 自动配置 ────────────────────────────────────────────────
    // 用户在网页上点一下「安装」，插件负责：下载 HeadOrbit → 装到 ~/Applications →
    // 把端口和 token 写进它的偏好 → 启动 → 等心跳。权限（动作与健身）只能由系统弹窗
    // 授予，所以这一步只做引导，并把「去系统设置」的按钮给出来。
    function portOf(req) {
      const host = String(req.headers?.host ?? '')
      const match = /:(\d+)$/.exec(host)
      return match === null ? null : Number(match[1])
    }

    register({
      path: SETUP_ROUTE,
      // 免 token：网页里的插件半区拿不到 token。但仍然只接受回环 Host + 同站请求。
      public: true,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          send(res, 405, { error: 'use GET or POST' })
          return
        }
        send(res, 200, {
          version: PLUGIN_VERSION,
          running: setupRunning,
          last: lastSetup,
          tokenConfigured: token !== '',
          port: portOf(req),
          app: { installed: await appInstalled(), running: await appRunning() },
          bridge: await readBridgeConfig(),
          alive: headOrbitAlive(),
        })
      },
    })

    register({
      path: `${SETUP_ROUTE}/run`,
      public: true,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'use POST' })
          return
        }
        if (setupRunning) {
          send(res, 409, { error: 'setup already running' })
          return
        }
        const body = await readBody(req).catch(() => ({}))
        const port = clampInt(body.port, 0, 1, 65_535) || portOf(req)
        if (port === null || port === 0) {
          send(res, 400, { error: 'cannot determine the DSH port from the request' })
          return
        }
        if (token === '') {
          send(res, 409, { error: 'plugin has no token; set one in the profile or delete the plugin state dir' })
          return
        }
        setupRunning = true
        record('setup', { reason: `start port=${port} reinstall=${body.reinstall === true}` })
        try {
          lastSetup = await runSetup({
            port,
            token,
            reinstall: body.reinstall === true,
            alive: async () => headOrbitAlive(),
            log: (line) => record('setup', { reason: line }),
          })
        } catch (err) {
          lastSetup = {
            ok: false,
            steps: [{ id: 'setup', status: 'failed', detail: String(err?.message ?? err) }],
          }
        } finally {
          setupRunning = false
        }
        send(res, lastSetup.ok ? 200 : 500, lastSetup)
      },
    })

    register({
      path: `${SETUP_ROUTE}/motion`,
      public: true,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'use POST' })
          return
        }
        try {
          const pane = await openMotionPane()
          send(res, 200, { ok: true, pane })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    })

    register({
      path: GESTURE_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'use POST' })
          return
        }
        const body = await readBody(req)
        const requestId = typeof body.requestId === 'string' ? body.requestId : undefined
        const result = decide(body.gesture, body.ttlMs, requestId)
        record('gesture', {
          gesture: String(body.gesture),
          accepted: result.body.accepted === true,
          reason: result.body.reason,
          source: requestId === undefined ? 'head' : 'card',
        })
        send(res, result.status, { ...result.body, waiting: pendingApproval !== null || pendingQuestion !== null })
      },
    })

    register({
      path: ANSWER_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'use POST' })
          return
        }
        const body = await readBody(req)
        const requestId = typeof body.requestId === 'string' ? body.requestId : undefined
        const result = answer(body.decision, requestId)
        send(res, result.status, { ...result.body, waiting: pendingApproval !== null || pendingQuestion !== null })
      },
    })

    register({
      path: SETTINGS_ROUTE,
      public: true,
      handler: async (req, res) => {
        if (req.method === 'POST') {
          const body = await readBody(req)
          const { next, changed } = mergeUserSettings(userSettings, body)
          userSettings = next
          try {
            saveUserSettings(userSettings)
          } catch (err) {
            record('settings-save-failed', { reason: String(err && err.message ? err.message : err) })
            send(res, 500, { error: 'settings: cannot save' })
            return
          }
          // 热应用：不用重启，下一次判定就用新值
          settings.debounceMs = userSettings.debounceMs ?? baseSettings.debounceMs
          settings.requireHeadOrbit = userSettings.requireHeadOrbit ?? baseSettings.requireHeadOrbit
          if (Object.keys(changed).length > 0) record('settings-changed', { reason: JSON.stringify(changed) })
          send(res, 200, {
            version: PLUGIN_VERSION,
            values: userSettings,
            applied: { debounceMs: settings.debounceMs, requireHeadOrbit: settings.requireHeadOrbit },
            system: { language: systemLanguage() },
            changed,
          })
          return
        }
        send(res, 200, {
          version: PLUGIN_VERSION,
          values: userSettings,
          applied: { debounceMs: settings.debounceMs, requireHeadOrbit: settings.requireHeadOrbit },
          limits: LIMITS,
          shortcutModes: SHORTCUT_MODES,
          system: { language: systemLanguage() },
          app: appUnits,
        })
      },
    })

    record('ready', { reason: `mounted at ${ROUTE_BASE}` })
  },
}
