/**
 * dsh-airpod-control 的行为测试：只依赖 node:test 和一个手写的假宿主上下文，
 * 不需要 @deepseek-ai/cordis —— 插件本身也只用到 ctx 上传进来的那几个能力。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

// 必须在 import 插件之前设置：installer.js 用它决定 token / endpoint.json 写到哪，
// 否则跑一次测试就会把用户真实的 ~/.dsh-airpod-control/endpoint.json 覆盖掉。
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-airpod-control-test-'))
process.env.DSH_AIRPOD_CONTROL_STATE = STATE_DIR

// 静态 import 会被提升到赋值之前，所以这里必须用动态 import
const { default: plugin } = await import('../lib/index.js')

const TOKEN = 'test-token'

/** 一个够用的假 profile 上下文：记录监听器、按 kind/path 存路由、能派发 watermark */
function makeHost() {
  const listeners = []
  const routes = new Map()
  const disposers = []
  const cleanups = []

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, listener) {
      listeners.push({ name, listener })
      const dispose = () => {
        const at = listeners.findIndex((it) => it.listener === listener)
        if (at !== -1) listeners.splice(at, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    inject(services, callback) {
      const scope = {
        approval: { name: 'approval' },
        webServer: { register },
      }
      const dispose = callback(scope)
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
  }

  function register(route) {
    const key = `${route.kind}:${route.path}`
    if (routes.has(key)) throw new Error(`duplicate route ${key}`)
    routes.set(key, route.handler)
    const dispose = () => routes.delete(key)
    disposers.push(dispose)
    return dispose
  }

  async function request(method, path, { body, token = TOKEN, query, host = '127.0.0.1:19387' } = {}) {
    const handler = routes.get(`exact:${path}`)
    if (handler === undefined) throw new Error(`no route ${path}`)
    const headers = { host }
    if (token !== null) headers['x-headorbit-token'] = token
    const req = {
      method,
      url: query === undefined ? path : `${path}?${query}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) {
          wrote = true
          yield Buffer.from(JSON.stringify(body), 'utf8')
        }
      },
    }
    let status = 0
    let payload = ''
    let wrote = false
    const res = {
      headersSent: false,
      writeHead(code) {
        status = code
        this.headersSent = true
      },
      end(chunk) {
        if (chunk !== undefined) payload += chunk.toString('utf8')
      },
    }
    await handler(req, res)
    // 请求带 body 但处理器一个字都没读：说明 for await 没生效，别让测试静默通过
    if (body !== undefined && !wrote) throw new Error(`handler never read the request body for ${path}`)
    return { status, body: payload === '' ? undefined : JSON.parse(payload) }
  }

  /** 网页那一侧的行为：'never'（没人管这张卡片）/ 'allow' / 'reject' / 'unavailable' */
  let browserMode = 'never'
  let browserCalls = 0

  /**
   * 假的「下一个回答者」= 真实宿主里把审批转发到网页卡片的那一路。
   * 返回 undefined 或不结算的 Promise 都表示「网页没给出答案」。
   */
  function browserNext() {
    browserCalls += 1
    if (browserMode === 'allow') return Promise.resolve('allowed-once')
    if (browserMode === 'reject') return Promise.resolve('rejected')
    if (browserMode === 'unavailable') return Promise.resolve('unavailable')
    return new Promise(() => {})
  }

  /** 模拟 HeadOrbit 的一次 /state 轮询：插件就是靠它判断「耳机那边还在线」 */
  function pollState() {
    const handler = routes.get(`exact:${'/dsh-airpod-control/state'}`)
    if (handler === undefined) return
    handler(
      { method: 'GET', headers: { host: '127.0.0.1:19387', 'x-headorbit-token': TOKEN } },
      { headersSent: false, writeHead() {}, end() {} },
    )
  }

  /** 派发一次审批请求，拿到「被认领的 Promise」或 undefined（表示交给了下一个回答者） */
  function askApproval({
    toolName = 'Bash',
    callId = 'call-1',
    input = { command: 'rm -rf /tmp/x' },
    signal,
    displayReason,
  } = {}) {
    const request = { agent: { session: { id: 'session-1' } }, toolName, callId, input, reason: 'sandbox', signal }
    if (displayReason !== undefined) request.displayReason = displayReason
    let claimed
    for (const { name, listener } of listeners) {
      if (name !== 'approval/request') continue
      const result = listener(request, browserNext)
      if (result !== undefined) {
        claimed = result
        break
      }
    }
    // 请求对象挂在 Promise 上，方便用例检查插件对它的改写（例如 displayReason）
    if (claimed !== undefined) claimed.$request = request
    return claimed
  }

  /** 派发一次 ask_user_question 请求；默认是「是/否」两选项，带 wait 表示限时提问 */
  function askQuestion({
    questions = [
      {
        id: 'q1',
        question: '要现在部署吗？',
        options: [{ label: '是，部署' }, { label: '先不部署' }],
      },
    ],
    signal,
    wait,
  } = {}) {
    let claimed
    for (const { name, listener } of listeners) {
      if (name !== 'user-questions/request') continue
      const result = listener({ questions, agent: { session: { id: 'session-1' } }, signal, wait }, browserNext)
      if (result !== undefined) {
        claimed = result
        break
      }
    }
    // 有的用例不需要答案（只是验证状态），给它们挂个空 catch：
    // 卸载/abort 时插件会 reject，没人接就会变成 unhandledRejection 把整个文件判失败
    if (claimed !== undefined && typeof claimed.catch === 'function') claimed.catch(() => {})
    return claimed
  }

  /** 跑完一个用例把还没结算的请求收掉：否则它的超时定时器会把整个测试进程留到 120 秒 */
  function stop() {
    for (const cleanup of cleanups) cleanup()
    for (const dispose of disposers) dispose()
  }

  return {
    ctx,
    request,
    askApproval,
    askQuestion,
    pollState,
    setBrowserMode: (mode) => {
      browserMode = mode
    },
    browserCalls: () => browserCalls,
    stop,
    routes,
    listeners,
    cleanups,
  }
}

function start(config = {}) {
  const { headOrbitOnline = true, ...pluginConfig } = config
  const host = makeHost()
  plugin.apply(host.ctx, { enabled: true, token: TOKEN, timeoutMs: 1_000, debounceMs: 0, ...pluginConfig })
  // 默认模拟「HeadOrbit 正在轮询」——只有它在线，插件才会去抢答
  if (headOrbitOnline) host.pollState()
  return host
}

test('关闭时什么都不注册', () => {
  const host = makeHost()
  plugin.apply(host.ctx, { enabled: false, token: TOKEN })
  assert.equal(host.routes.size, 0)
  assert.equal(host.listeners.length, 0)
})

test('没配 token 时自动生成一份共享 token，并用它认领请求', async () => {
  // 状态目录在测试里被挪到临时目录（见文件顶部），所以这里也读那边
  const file = path.join(STATE_DIR, 'token')
  const existed = fs.existsSync(file)
  const before = existed ? fs.readFileSync(file, 'utf8') : null

  const host = start({ token: '' })
  // 自动生成之后就该照常认领（审批 + 提问两个通道）
  assert.equal(host.listeners.length, 2)

  const generated = fs.readFileSync(file, 'utf8').trim()
  assert.ok(generated.length >= 16, 'token should be generated on first run')

  // 认证在读 body 之前就挡掉了，所以这里不带 body
  const bad = await host.request('POST', '/dsh-airpod-control/gesture', { token: 'nope' })
  assert.equal(bad.status, 401)
  const ok = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' }, token: generated })
  assert.equal(ok.status, 200)

  // 别把用户机器上真的 token 弄脏
  if (existed) fs.writeFileSync(file, before)
  else fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('没有请求在等的时候，手势不会造成任何答案', async () => {
  const host = start()
  const state = await host.request('GET', '/dsh-airpod-control/state')
  assert.equal(state.status, 200)
  assert.equal(state.body.waiting, false)

  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.equal(gesture.status, 200)
  assert.equal(gesture.body.accepted, false)
})

test('点头＝允许：先认领请求，再被手势结算 allowed-once', async () => {
  const host = start()
  const answer = host.askApproval()

  const waiting = await host.request('GET', '/dsh-airpod-control/state')
  assert.equal(waiting.body.waiting, true)
  assert.equal(waiting.body.label, 'Bash')
  assert.equal(waiting.body.canAnswer, true)
  assert.ok(waiting.body.params.includes('rm -rf'))

  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(gesture.body.accepted, true)
  assert.equal(gesture.body.decision, 'allowed-once')
  assert.equal(await answer, 'allowed-once')
  assert.equal((await host.request('GET', '/dsh-airpod-control/state')).body.waiting, false)
})

test('摇头＝拒绝', async () => {
  const host = start()
  const answer = host.askApproval()
  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake' } })
  assert.equal(gesture.body.decision, 'rejected')
  assert.equal(await answer, 'rejected')
})

test('nodAllows=false 时反过来：摇头＝允许', async () => {
  const host = start({ nodAllows: false })
  const answer = host.askApproval()
  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake' } })
  assert.equal(gesture.body.decision, 'allowed-once')
  assert.equal(await answer, 'allowed-once')
})

test('请求超时后按拒绝结算，不会永远挂着', async () => {
  const host = start({ timeoutMs: 60 })
  const answer = host.askApproval()
  assert.equal(await answer, 'rejected')
})

test('请求被中止（Esc / 停止）结算为 cancelled', async () => {
  const host = start()
  const controller = new AbortController()
  const answer = host.askApproval({ signal: controller.signal })
  controller.abort()
  assert.equal(await answer, 'cancelled')
})

test('一个请求只结算一次：结算之后再来的手势只报「没人在等」', async () => {
  const host = start()
  const answer = host.askApproval()
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  const again = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake' } })
  assert.equal(again.body.accepted, false)
  assert.equal(await answer, 'allowed-once')
})

test('已经有请求在等时，第二个请求交给下一个回答者', async () => {
  const host = start()
  const first = host.askApproval({ callId: 'call-1' })
  // 让位 = 直接返回 next() 那个 promise（网页卡片的答案会从这条链路回来），不再自造 undefined
  assert.equal(host.browserCalls(), 1)
  assert.ok(host.askApproval({ callId: 'call-2' }) instanceof Promise)
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.equal(await first, 'allowed-once')
})

test('debounce 期间的手势被忽略', async () => {
  const host = start({ debounceMs: 5_000 })
  host.askApproval()
  const first = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.equal(first.body.accepted, true)
  const second = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.equal(second.status, 429)
})

test('/answer 是无耳机时的等价入口', async () => {
  const host = start()
  const answer = host.askApproval()
  const result = await host.request('POST', '/dsh-airpod-control/answer', { body: { decision: 'allow' } })
  assert.equal(result.body.decision, 'allowed-once')
  assert.equal(await answer, 'allowed-once')
})

test('非 POST / 未知手势 / 非法 body 都被挡住', async () => {
  const host = start()
  assert.equal((await host.request('GET', '/dsh-airpod-control/gesture')).status, 405)
  assert.equal((await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'wiggle' } })).status, 400)
  assert.equal((await host.request('POST', '/dsh-airpod-control/answer', { body: { decision: 'maybe' } })).status, 400)
})

test('token 不对 / Host 不是回环 / 跨站都被挡住', async () => {
  const host = start()
  assert.equal((await host.request('GET', '/dsh-airpod-control/state', { token: 'wrong' })).status, 401)
  assert.equal((await host.request('GET', '/dsh-airpod-control/state', { token: null })).status, 401)
  assert.equal((await host.request('GET', '/dsh-airpod-control/state', { host: 'evil.example:19387' })).status, 403)
})

test('/health 只做自检，不回报 token 本身', async () => {
  const host = start()
  const health = await host.request('GET', '/dsh-airpod-control/health')
  assert.equal(health.body.ok, true)
  assert.equal(health.body.hasToken, true)
  assert.equal(health.body.hasApprovalAnswerer, true)
  assert.equal(health.body.hasQuestionAnswerer, true)
  assert.equal(JSON.stringify(health.body).includes(TOKEN), false)
})

test('卸载时把挂着的请求结算掉，不留死 Promise', async () => {
  const host = start()
  const answer = host.askApproval()
  for (const cleanup of host.cleanups) cleanup()
  assert.equal(await answer, 'unavailable')
})

// ── 提问（ask_user_question）────────────────────────────────────────────────

test('点头＝是：选中的是「同意」那一个选项', async () => {
  const host = start()
  const answer = host.askQuestion()
  const waiting = await host.request('GET', '/dsh-airpod-control/state')
  assert.equal(waiting.body.waiting, true)
  assert.equal(waiting.body.kind, 'question')
  assert.equal(waiting.body.label, '要现在部署吗？')

  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(gesture.body.accepted, true)
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['是，部署'] }] })
})

test('摇头＝否：选中的是「否定」那一个选项', async () => {
  const host = start()
  const answer = host.askQuestion()
  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake', ttlMs: 1_000 } })
  assert.equal(gesture.body.answers[0].selected[0], '先不部署')
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['先不部署'] }] })
})

test('模型声明了 intent.approve 时以它为准（即使它在最后一项）', async () => {
  const host = start()
  // intent 的实际形状照真实 DSH 抄：dsh-client-ui-user-questions 用
  // `options.find((option) => option.label === intent.approve)` 来找「同意」那一个
  const answer = host.askQuestion({
    questions: [
      {
        id: 'q1',
        question: '允许读取这个文件吗？',
        intent: { kind: 'plan-review', approve: '允许' },
        options: [{ label: '不允许' }, { label: '允许' }],
      },
    ],
  })
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['允许'] }] })
})

test('intent 说第一项是「同意」时，点头选第一项、摇头选另一项', async (t) => {
  const host = start()
  t.after(() => host.stop())
  const answer = host.askQuestion({
    questions: [
      {
        id: 'q1',
        header: '部署',
        question: '现在就把这个版本发到生产吗？',
        intent: { kind: 'plan-review', approve: '直接发' },
        options: [{ label: '先跑测试' }, { label: '直接发' }],
      },
    ],
  })
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['直接发'] }] })

  const other = start()
  t.after(() => other.stop())
  const answer2 = other.askQuestion({
    questions: [
      {
        id: 'q1',
        intent: { kind: 'plan-review', approve: '直接发' },
        options: [{ label: '先跑测试' }, { label: '直接发' }],
      },
    ],
  })
  await other.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake', ttlMs: 1_000 } })
  assert.deepEqual(await answer2, { answers: [{ id: 'q1', selected: ['先跑测试'] }] })
})

test('/answer 可以直接点名某一项（手势表达不了的那种选择）', async (t) => {
  const host = start()
  t.after(() => host.stop())
  const answer = host.askQuestion({
    questions: [
      {
        id: 'q1',
        question: '用哪种方案？',
        options: [{ label: '保守' }, { label: '激进' }, { label: '先不动' }],
      },
    ],
  })
  const res = await host.request('POST', '/dsh-airpod-control/answer', { body: { decision: 'select:2' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.answers, [{ id: 'q1', selected: ['先不动'] }])
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['先不动'] }] })
})

test('/answer 点名越界或对没有选项的题点名时都是 400，不会乱答', async (t) => {
  const host = start()
  t.after(() => host.stop())
  host.askQuestion({
    questions: [{ id: 'q1', question: '用哪种方案？', options: [{ label: '保守' }, { label: '激进' }] }],
  })
  const out = await host.request('POST', '/dsh-airpod-control/answer', { body: { decision: 'select:9' } })
  assert.equal(out.status, 400)
  assert.equal(out.body.accepted, false)
  // 明确「不是过期，是你点错了」：卡片据此决定要不要刷新
  assert.equal(out.body.stale, false)
})

test('nodAllows=false 时提问也跟着反过来', async () => {
  const host = start({ nodAllows: false })
  const answer = host.askQuestion()
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake', ttlMs: 1_000 } })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['是，部署'] }] })
})

test('自由文本提问没有选项：点头/摇头落成自定义回答', async () => {
  const host = start()
  const answer = host.askQuestion({ questions: [{ id: 'q1', question: '这一版叫什么名字？' }] })
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: [], custom: '是' }] })
  const shakeHost = start()
  const shakeAnswer = shakeHost.askQuestion({ questions: [{ id: 'q1', question: '这一版叫什么名字？' }] })
  await shakeHost.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake', ttlMs: 1_000 } })
  assert.deepEqual(await shakeAnswer, { answers: [{ id: 'q1', selected: [], custom: '否' }] })
})

test('多选题：点头＝全选，摇头＝全不选', async () => {
  const host = start()
  const answer = host.askQuestion({
    questions: [
      {
        id: 'q1',
        question: '要装哪些？',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
  })
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake', ttlMs: 1_000 } })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: [] }] })
})

test('一批多个问题：一次手势把整批答完，逐题按自己的选项映射', async () => {
  const host = start()
  const answer = host.askQuestion({
    questions: [
      { id: 'q1', question: '继续吗？', options: [{ label: '继续' }, { label: '停' }] },
      { id: 'q2', question: '另外开一个窗口吗？', options: [{ label: '是' }, { label: '否' }] },
    ],
  })
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.deepEqual(await answer, {
    answers: [
      { id: 'q1', selected: ['继续'] },
      { id: 'q2', selected: ['是'] },
    ],
  })
})

test('选项多于八个、或 claimQuestions=off：交给下一个回答者（网页卡片照旧）', async () => {
  const tooMany = start()
  // 9 个选项超出「摇头切换」能表达的范围：不认领，原样让给网页卡片
  assert.ok(
    tooMany.askQuestion({
      questions: [
        {
          id: 'q1',
          question: '选一个',
          options: Array.from({ length: 9 }, (_, index) => ({ label: `选项${String(index + 1)}` })),
        },
      ],
    }) instanceof Promise,
  )

  const off = start({ claimQuestions: 'off' })
  // 关掉提问通道时连监听器都不注册：请求根本不经过插件
  assert.equal(off.browserCalls(), 0)
  assert.equal(off.askQuestion(), undefined)
  assert.equal((await off.request('GET', '/dsh-airpod-control/health')).body.hasQuestionAnswerer, false)
})

// ── 多选项：摇头切换、点头确认 ──────────────────────────────────────────

const threeOptions = () => ({
  questions: [
    { id: 'q1', question: '选哪种？', options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }] },
  ],
})

test('多选项：摇一次到第二项，点头＝第二项（/state 能看到光标）', async (t) => {
  const host = start()
  t.after(() => host.stop())
  const answer = host.askQuestion(threeOptions())

  const shake = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake' } })
  assert.equal(shake.body.accepted, true)
  assert.equal(shake.body.pending, true)
  assert.equal(shake.body.cursor, 1)
  assert.equal(shake.body.selectedLabel, '乙')

  const state = await host.request('GET', '/dsh-airpod-control/state')
  assert.equal(state.body.question.cursor, 1)
  assert.equal(state.body.question.selectedLabel, '乙')
  assert.equal(state.body.waiting, true)

  const nod = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.equal(nod.body.decision, 'answer')
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['乙'] }] })
})

test('/cursor 免 token 就能读到「现在会选第几项」，且不泄露题干', async (t) => {
  const host = start()
  t.after(() => host.stop())
  host.askQuestion(threeOptions())

  const idle = await host.request('GET', '/dsh-airpod-control/cursor', { token: null })
  assert.equal(idle.status, 200)
  assert.equal(idle.body.waiting, true)
  assert.equal(idle.body.index, 1)
  assert.equal(idle.body.total, 3)
  assert.equal(idle.body.option, '甲')
  assert.equal(idle.body.question, undefined)

  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake' } })
  const moved = await host.request('GET', '/dsh-airpod-control/cursor', { token: null })
  assert.equal(moved.body.index, 2)
  assert.equal(moved.body.option, '乙')
  assert.equal(moved.body.kind, 'question')
})

test('多选项：不动就点头＝第一项；摇满一圈回到第一项', async (t) => {
  const plain = start()
  t.after(() => plain.stop())
  const first = plain.askQuestion(threeOptions())
  const state0 = await plain.request('GET', '/dsh-airpod-control/state')
  assert.equal(state0.body.question.cursor, 0)
  await plain.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.deepEqual(await first, { answers: [{ id: 'q1', selected: ['甲'] }] })

  const wrap = start()
  t.after(() => wrap.stop())
  const second = wrap.askQuestion(threeOptions())
  for (let index = 0; index < 3; index += 1) {
    await wrap.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake' } })
  }
  const state = await wrap.request('GET', '/dsh-airpod-control/state')
  assert.equal(state.body.question.cursor, 0)
  await wrap.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.deepEqual(await second, { answers: [{ id: 'q1', selected: ['甲'] }] })
})

test('多选项：点头之前一直挂着，摇几次只移动光标', async (t) => {
  const host = start()
  t.after(() => host.stop())
  host.askQuestion(threeOptions())
  for (let index = 0; index < 4; index += 1) {
    const res = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake' } })
    assert.equal(res.body.accepted, true)
    assert.equal(res.body.pending, true)
  }
  const state = await host.request('GET', '/dsh-airpod-control/state')
  assert.equal(state.body.question.cursor, 4 % 3)
  assert.equal(state.body.waiting, true)
})

test('计划审查题：光标从「同意」那一项开始', async (t) => {
  const host = start()
  t.after(() => host.stop())
  const answer = host.askQuestion({
    questions: [
      {
        id: 'q1',
        question: '批准这个计划吗？',
        options: [{ label: '先别动' }, { label: '开始实施' }, { label: '再改改' }],
        intent: { kind: 'plan-review', approve: '开始实施' },
      },
    ],
  })
  const state = await host.request('GET', '/dsh-airpod-control/state')
  assert.equal(state.body.question.cursor, 1)
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['开始实施'] }] })
})

test('提问没人答：超时按 ASK_TIMED_OUT 抛，工具会返回 pending 而不是卡死', async () => {
  const host = start({ questionTimeoutMs: 40 })
  const answer = host.askQuestion()
  await assert.rejects(answer, (err) => {
    assert.equal(err.name, 'UserQuestionError')
    assert.equal(err.code, 'ASK_TIMED_OUT')
    return true
  })
  assert.equal((await host.request('GET', '/dsh-airpod-control/state')).body.waiting, false)
})

test('提问被中止（Esc / 停止）时抛 ASK_CANCELLED，而不是把 undefined 交回宿主', async () => {
  // 这条是 2026-10-21 改的：老实现 abort 时 resolve(undefined)，宿主拿它当答案去读 .answers，
  // 整轮工具调用直接 "Cannot read properties of undefined (reading 'answers')"。
  const host = start()
  const controller = new AbortController()
  const answer = host.askQuestion({ signal: controller.signal })
  assert.equal((await host.request('GET', '/dsh-airpod-control/state')).body.waiting, true)
  controller.abort()
  await assert.rejects(answer, (err) => {
    assert.equal(err.name, 'UserQuestionError')
    assert.equal(err.code, 'ASK_CANCELLED')
    return true
  })
  assert.equal((await host.request('GET', '/dsh-airpod-control/state')).body.waiting, false)
})

test('网页卡片按 requestId 回答：过期的 id 会被 409 挡住，不误答新问题', async () => {
  const host = start()
  const answer = host.askQuestion()
  const stale = await host.request('POST', '/dsh-airpod-control/gesture', {
    body: { gesture: 'nod', requestId: 'q999' },
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.stale, true)

  const live = (await host.request('GET', '/dsh-airpod-control/state')).body.question.requestId
  const ok = await host.request('POST', '/dsh-airpod-control/answer', { body: { decision: 'allow', requestId: live } })
  assert.equal(ok.body.accepted, true)
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['是，部署'] }] })
})

test('提问优先于审批：两边都在等时，手势先答提问', async () => {
  const host = start()
  const approval = host.askApproval()
  const question = host.askQuestion()
  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(gesture.body.decision, 'nod')
  await question
  // 审批还挂着，还需要一次手势
  assert.equal((await host.request('GET', '/dsh-airpod-control/state')).body.kind, 'approval')
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(await approval, 'allowed-once')
})

// ── 在线判定：HeadOrbit 不在线时一行都不碰 ────────────────────────────────────

test('HeadOrbit 从没轮询过：请求原样交给网页卡片，手势槽也不占', async () => {
  const host = start({ headOrbitOnline: false })
  // 认领 0 次，全部原样交给链路后面的回答者（浏览器卡片），自己不自造答案
  assert.ok(host.askApproval() instanceof Promise)
  assert.ok(host.askQuestion() instanceof Promise)
  assert.equal(host.browserCalls(), 2)
  // 网页自己也答不上来时，插件不该是那个把结论定成 rejection 的人
  const state = (await host.request('GET', '/dsh-airpod-control/state')).body
  assert.equal(state.waiting, false)
  assert.equal(state.headOrbit.alive, false)
})

test('HeadOrbit 掉线（超过 aliveWindowMs 没轮询）后同样让位', async () => {
  const host = start({ aliveWindowMs: 1_000 })
  assert.equal((await host.request('GET', '/dsh-airpod-control/state')).body.headOrbit.alive, true)
  await new Promise((r) => setTimeout(r, 1_100))
  assert.equal((await host.request('GET', '/dsh-airpod-control/state')).body.headOrbit.alive, false)
  // 注意：这次 /state 又把它算成在线了（轮询即心跳），所以先派发再断言
  const offline = start({ aliveWindowMs: 1_000 })
  await new Promise((r) => setTimeout(r, 1_100))
  assert.ok(offline.askApproval() instanceof Promise)
})

test('requireHeadOrbit=false 时不等心跳：没有 HeadOrbit 也能用手势（用 curl 验的时候开）', async () => {
  const host = start({ requireHeadOrbit: false, headOrbitOnline: false })
  const approval = host.askApproval()
  assert.notEqual(approval, undefined)
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(await approval, 'allowed-once')
  // 心跳状态本身照实上报，只是不再拿它当门槛
  const state = (await host.request('GET', '/dsh-airpod-control/state')).body
  assert.equal(state.headOrbit.required, false)
})

// ── 和网页卡片赛跑：两边都能答，谁先到算谁的 ─────────────────────────────────

test('认领的同时仍然调用 next()，让网页卡片照常渲染', async () => {
  const host = start()
  const approval = host.askApproval()
  assert.notEqual(approval, undefined)
  assert.equal(host.browserCalls(), 1)
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(await approval, 'allowed-once')
})

test('网页卡片先点了「拒绝」：以网页为准，之后的手势不会重复结算', async () => {
  const host = start()
  host.setBrowserMode('reject')
  const approval = host.askApproval()
  assert.equal(await approval, 'rejected')
  const after = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(after.body.accepted, false)
  assert.equal(after.body.reason, 'nothing is waiting for a decision')
})

test('网页那一路返回 unavailable（没有回答者）时，手势仍然能答', async () => {
  const host = start()
  host.setBrowserMode('unavailable')
  const approval = host.askApproval()
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(await approval, 'allowed-once')
})

test('提问也一样：网页卡片先答就以网页为准', async () => {
  const host = start()
  host.setBrowserMode('allow')
  const answer = host.askQuestion()
  assert.equal(await answer, 'allowed-once')
  const state = (await host.request('GET', '/dsh-airpod-control/state')).body
  assert.equal(state.waiting, false)
  assert.equal(state.ignored >= 1, true)
})

test('审批卡片上会印上「点头＝允许 / 摇头＝拒绝」的提示', async (t) => {
  const host = start()
  t.after(() => host.stop())

  const answer = host.askApproval()
  assert.ok(answer.$request.displayReason.includes('点头＝允许'))

  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod', ttlMs: 1_000 } })
  assert.equal(gesture.body.accepted, true)
  assert.equal(await answer, 'allowed-once')
})

test('请求自带 displayReason 时不覆盖', async (t) => {
  const host = start()
  t.after(() => host.stop())

  const answer = host.askApproval({ displayReason: 'host 自己的说明' })
  assert.equal(answer.$request.displayReason, 'host 自己的说明')

  const gesture = await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake', ttlMs: 1_000 } })
  assert.equal(gesture.body.accepted, true)
  assert.equal(await answer, 'rejected')
})

// ── 浏览器端 bundle 的加载冒烟测试 ───────────────────────────────────────────
// 客户端半区是被宿主当 ES 模块 import 的：模块体里抛一次异常，整个插件就
// 「import failed」被禁掉（曾经因为文案表在初始化时自引用 t() 而在重启后集体
// 失效）。这里用最小桩把 factory 真跑一遍，两种语言都跑，顺便校验文案表。

const CLIENT_SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadClientBundle(language) {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
    navigator: { language },
    console: { debug() {}, warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'ModuleLoader.load 没被调用')
  assert.equal(captured.id, 'dsh-airpod-control')
  const factory = captured.factory
  const bundle = factory((name) => {
    if (name === 'react') return { createElement() {}, Fragment: {}, useState() {}, useEffect() {} }
    throw new Error(`unexpected require(${name})`)
  })
  assert.equal(bundle.name, 'dsh-airpod-control')
  // 数组来自 vm 沙箱，拷进本 realm 再比原型
  assert.deepEqual([...bundle.inject], ['uiSession', 'slots'])
  assert.equal(typeof bundle.apply, 'function')
  return bundle
}

/**
 * 最小 DOM 桩：只实现浏览器半区真的会碰到的那部分 API。
 * 目的不是「模拟浏览器」，而是把 apply() 和设置页真的跑一遍——
 * import 期不抛 ≠ 运行期不抛：语言表自引用、作用域写错都会让设置页整页空白，
 * 而这两种都只有在真正 mount 一次时才炸出来。
 */
function makeStubElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    style: {},
    children: [],
    childNodes: [],
    attrs: {},
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    className: '',
    parentElement: null,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    removeAttribute(k) { delete this.attrs[k] },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    hasAttribute(k) { return k in this.attrs },
    appendChild(child) { this.children.push(child); this.childNodes.push(child); child.parentElement = this; return child },
    insertBefore(child) { return this.appendChild(child) },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child },
    remove() { if (this.parentElement) this.parentElement.removeChild(this) },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    focus() {},
    click() {},
  }
  return el
}

/** 桩元素不聚合 textContent，自己往下走一遍把文字收上来 */
function stubText(node) {
  if (node === null || node === undefined) return ''
  let out = typeof node.textContent === 'string' ? node.textContent : ''
  const children = node.children || []
  for (const child of children) out += ' ' + stubText(child)
  return out
}

/** 把浏览器半区装进 vm 里跑起来：settings 接口回什么、系统语言是什么都可控 */
function bootClient(options) {
  const settingsBody = {
    values: { language: (options && options.language) || 'auto', voiceShortcut: 'arrows' },
    system: { language: (options && options.system) || 'zh' },
    app: { unitNod: 12, unitTurn: 19 },
  }
  let captured = null
  const document = {
    documentElement: makeStubElement('html'),
    head: makeStubElement('head'),
    body: makeStubElement('body'),
    createElement: (tag) => makeStubElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    addEventListener() {},
    removeEventListener() {},
    readyState: 'complete',
  }
  const view = {
    document,
    navigator: { language: 'en-US', languages: ['en-US'] },
    location: { href: 'http://127.0.0.1:1234/', origin: 'http://127.0.0.1:1234' },
    innerWidth: 1440,
    innerHeight: 900,
    // 定时器一律不真跑：半区的轮询会自己续命，真跑会让测试进程永远不退出
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    __ModuleLoader__: { load: (definition) => { captured = definition } },
  }
  view.window = view
  const sandbox = {
    window: view,
    document,
    navigator: view.navigator,
    console: { debug() {}, warn() {}, info() {}, log() {}, error() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, JSON, Map, Set, Promise,
    fetch: (url) => {
      if (String(url).indexOf('/settings') !== -1) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(settingsBody) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'ModuleLoader.load 没被调用')

  const effects = []
  const host = makeStubElement('div')
  const react = {
    createElement() { return {} },
    Fragment: {},
    useState: (initial) => [initial, () => {}],
    useEffect: (fn) => { effects.push(fn) },
    useRef: () => ({ current: host }),
  }
  const bundle = captured.factory((name) => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: {} }
    throw new Error(`unexpected require(${name})`)
  })

  let registered = null
  let label = null
  const ctx = {
    uiSession: { sessionStatus: { getSnapshot: () => new Map() } },
    slots: {
      inject: (name, cb) => cb(),
      register: (spec, component) => { registered = component; label = spec.label; return () => {} },
    },
    effect: (fn) => fn(),
    logger: { info() {}, warn() {}, error() {} },
  }
  return {
    bundle,
    ctx,
    apply: () => bundle.apply(ctx),
    /** 等一轮 microtask：设置拉回来之后语言才定下来（这里用测试进程自己的定时器） */
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    label: () => label(),
    /** 真把设置页挂一次（拿 useEffect 里的 mountSettingsPage 跑） */
    mountSettings: () => {
      const tree = registered()
      for (const fn of effects) fn()
      return tree
    },
    host,
    text: () => stubText(host),
  }
}

test('浏览器半区：apply 跑得通、设置页挂得起来（作用域写错会让整页空白）', async () => {
  const client = bootClient({ system: 'zh' })
  assert.deepEqual([...client.bundle.inject], ['uiSession', 'slots'])
  client.apply()
  await client.settle()

  // 语言按宿主上报的系统语言走：中文系统 → 中文侧栏文案
  assert.equal(client.label(), 'AirPods 控制')

  client.mountSettings()
  assert.ok(client.host.children.length > 10, '设置页应该真的画出东西来')
  assert.match(client.text(), /界面语言/)
  assert.match(client.text(), /手势幅度/)
})

test('浏览器半区：手动指定 English 时覆盖系统语言', async () => {
  const client = bootClient({ system: 'zh', language: 'en' })
  client.apply()
  await client.settle()
  assert.equal(client.label(), 'AirPods control')
  client.mountSettings()
  assert.match(client.text(), /Language/)
})

test('浏览器端 bundle 在中文 / 英文环境下都能加载（import 期不抛异常）', () => {
  loadClientBundle('zh-CN')
  loadClientBundle('en-US')
})

test('浏览器端文案表：中英键集合一致，t() 用到的键都存在', () => {
  const start = CLIENT_SOURCE.indexOf('var STRINGS = {')
  assert.ok(start !== -1, '找不到文案表')
  const open = CLIENT_SOURCE.indexOf('{', start)
  let depth = 0
  let end = open
  for (; end < CLIENT_SOURCE.length; end += 1) {
    if (CLIENT_SOURCE[end] === '{') depth += 1
    else if (CLIENT_SOURCE[end] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const literal = CLIENT_SOURCE.slice(open, end + 1)
  // 求值时就传一个会炸的 t()：文案表内部的任何自引用都会在测试里现形
  const strings = new Function('t', `return (${literal})`)(() => {
    throw new Error('文案表初始化时不能调用 t()')
  })

  const zh = Object.keys(strings.zh).sort()
  const en = Object.keys(strings.en).sort()
  assert.deepEqual(en, zh, '中英文案表键不一致')
  for (const key of zh) {
    assert.equal(typeof strings.zh[key], 'string', `zh.${key} 不是字符串`)
    assert.ok(strings.zh[key].length > 0, `zh.${key} 是空字符串`)
    assert.equal(typeof strings.en[key], 'string', `en.${key} 不是字符串`)
    assert.ok(strings.en[key].length > 0, `en.${key} 是空字符串`)
  }

  const used = new Set([...CLIENT_SOURCE.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]))
  const missing = [...used].filter((key) => !(key in strings.zh) && !(key in strings.en))
  assert.deepEqual(missing, [], `t() 用到但表里没有的键：${missing.join(', ')}`)
})

test('/motion 回最近一次的点头/摇头幅度和 App 报上来的阈值（设置页画实时条用）', async (t) => {
  const host = start()
  t.after(() => host.stop())

  // App 报的是姿势的绝对值（SceneEngine 里已经是 abs(pose.pitch)），插件再夹一次非负兜底
  await host.request('GET', '/dsh-airpod-control/state', { query: 'pitch=12.34&yaw=7.26&nod=13&turn=21' })
  const motion = await host.request('GET', '/dsh-airpod-control/motion', { token: null })
  assert.equal(motion.status, 200)
  assert.equal(motion.body.pitch, 12.3)
  assert.equal(motion.body.yaw, 7.3)
  assert.equal(motion.body.nod, 13)
  assert.equal(motion.body.turn, 21)
  assert.ok(typeof motion.body.at === 'number' && motion.body.at > 0)

  await host.request('GET', '/dsh-airpod-control/state', { query: 'pitch=-9&yaw=-4' })
  const clamped = await host.request('GET', '/dsh-airpod-control/motion', { token: null })
  assert.equal(clamped.body.pitch, 0, '幅度条不会出现负值')
  assert.equal(clamped.body.yaw, 0)
})

test('/client-state：浏览器半区的心跳能读到（分不清「没加载」和「没触发」会白查很久）', async (t) => {
  const host = start()
  t.after(() => host.stop())

  const before = await host.request('GET', '/dsh-airpod-control/client-state', { token: null })
  assert.equal(before.status, 200)
  assert.equal(before.body.boots, 0)
  assert.equal(before.body.bootAt, null)

  await host.request('POST', '/dsh-airpod-control/client-state', {
    token: null,
    body: { kind: 'boot', lang: 'zh', at: Date.now() },
  })
  const booted = await host.request('GET', '/dsh-airpod-control/client-state', { token: null })
  assert.equal(booted.body.boots, 1)
  assert.equal(booted.body.lang, 'zh')
  assert.ok(booted.body.bootAt > 0)

  await host.request('POST', '/dsh-airpod-control/client-state', {
    token: null,
    body: { kind: 'note', text: '已允许 Bash', channel: 'whale' },
  })
  const noted = await host.request('GET', '/dsh-airpod-control/client-state', { token: null })
  assert.equal(noted.body.notes, 1)
  assert.equal(noted.body.text, '已允许 Bash')
  assert.equal(noted.body.channel, 'whale')
})

test('设置：读写即时生效，越界值被夹到范围内，非法值被丢掉', async (t) => {
  const host = start()
  t.after(() => host.stop())

  const initial = await host.request('GET', '/dsh-airpod-control/settings', { token: null })
  assert.equal(initial.status, 200)
  assert.deepEqual(Object.keys(initial.body.limits).sort(), ['debounceMs', 'unitNod', 'unitTurn'])
  assert.deepEqual([...initial.body.shortcutModes], ['arrows', 'ctrl-space', 'off'])
  assert.equal(initial.body.values.unitNod, null)

  const saved = await host.request('POST', '/dsh-airpod-control/settings', {
    token: null,
    body: { unitNod: 999, unitTurn: 3, debounceMs: -5, voiceShortcut: 'off' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.values.unitNod, 22, '超过上限要被夹到 22')
  assert.equal(saved.body.values.unitTurn, 12, '低于下限要被夹到 12')
  assert.equal(saved.body.values.debounceMs, 0)
  assert.equal(saved.body.values.voiceShortcut, 'off')
  assert.equal(saved.body.applied.debounceMs, 0, '去抖要立刻应用到当前会话')

  // 落盘落在测试自己的 state 目录里，绝不能写用户真实的 ~/.dsh-airpod-control
  const onDisk = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'settings.json'), 'utf8'))
  assert.equal(onDisk.unitNod, 22)
  assert.equal(onDisk.voiceShortcut, 'off')

  const ignored = await host.request('POST', '/dsh-airpod-control/settings', {
    token: null,
    body: { voiceShortcut: 'nope', cursorHighlight: 'yes' },
  })
  assert.equal(ignored.status, 200)
  assert.equal(ignored.body.values.voiceShortcut, 'off', '非法快捷键模式不改')
  assert.equal(ignored.body.values.cursorHighlight, true)

  const cleared = await host.request('POST', '/dsh-airpod-control/settings', {
    token: null,
    body: { unitNod: null },
  })
  assert.equal(cleared.body.values.unitNod, null, 'null = 回到 App 自己算的值')
})

test('设置：界面语言跟着系统走，也能手动指定；乱写的值被丢掉', async (t) => {
  const host = start()
  t.after(() => host.stop())

  const initial = await host.request('GET', '/dsh-airpod-control/settings', { token: null })
  assert.equal(initial.body.values.language, 'auto', '默认跟随系统')
  // 宿主把系统语言算出来交给前端：Electron 的 navigator.language 不可信（实测中文系统报 en-US）
  assert.ok(['zh', 'en', null].includes(initial.body.system.language))
  // 只有 macOS 能读到真实偏好，其它平台别把测试写死在这台机器上
  if (process.platform === 'darwin') {
    let expected = null
    try {
      const text = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' })
      const first = /"([^"]+)"/.exec(text)
      expected = first === null ? null : /^zh/i.test(first[1]) ? 'zh' : 'en'
    } catch {
      expected = null
    }
    assert.equal(initial.body.system.language, expected)
  }

  const picked = await host.request('POST', '/dsh-airpod-control/settings', {
    token: null,
    body: { language: 'en' },
  })
  assert.equal(picked.status, 200)
  assert.equal(picked.body.values.language, 'en')
  assert.equal(picked.body.changed.language, 'en')
  assert.equal(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'settings.json'), 'utf8')).language, 'en')

  const bogus = await host.request('POST', '/dsh-airpod-control/settings', {
    token: null,
    body: { language: 'klingon' },
  })
  assert.equal(bogus.body.values.language, 'en', '不认识的语言不动')
  assert.equal(bogus.body.changed.language, undefined)

  const back = await host.request('POST', '/dsh-airpod-control/settings', {
    token: null,
    body: { language: 'auto' },
  })
  assert.equal(back.body.values.language, 'auto')
})

test('/cursor 在审批卡片上也报 waiting=true（否则网页半区永远不会把「允许」按钮点亮）', async (t) => {
  const host = start()
  t.after(() => host.stop())
  const answer = host.askApproval()

  const waiting = await host.request('GET', '/dsh-airpod-control/cursor', { token: null })
  assert.equal(waiting.status, 200)
  assert.equal(waiting.body.waiting, true)
  assert.equal(waiting.body.kind, 'approval')

  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.equal(await answer, 'allowed-once')
  const after = await host.request('GET', '/dsh-airpod-control/cursor', { token: null })
  assert.equal(after.body.waiting, false)
  assert.equal(after.body.kind, null)
})

test('/last-decision 带上「刚才选中的是哪一项」：卡片收得太快，网页半区靠它提示结果', async (t) => {
  const host = start()
  t.after(() => host.stop())
  const answer = host.askQuestion(threeOptions())

  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'shake' } })
  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['乙'] }] })

  const decision = await host.request('GET', '/dsh-airpod-control/last-decision', { token: null })
  assert.equal(decision.body.decision.kind, 'question')
  assert.equal(decision.body.decision.option, '乙')
  assert.match(decision.body.decision.reason, /乙/)
})

test('/last-decision 的审批决定没有「选项」，网页半区该说「点头 → 允许」而不是某一项', async (t) => {
  const host = start()
  t.after(() => host.stop())
  const answer = host.askApproval()

  await host.request('POST', '/dsh-airpod-control/gesture', { body: { gesture: 'nod' } })
  assert.equal(await answer, 'allowed-once')
  const decision = await host.request('GET', '/dsh-airpod-control/last-decision', { token: null })
  assert.equal(decision.body.decision.outcome, 'allowed-once')
  assert.equal(decision.body.decision.option, null)
})
