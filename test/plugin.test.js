/**
 * dsh-airpod-control 的行为测试：只依赖 node:test 和一个手写的假宿主上下文，
 * 不需要 @deepseek-ai/cordis —— 插件本身也只用到 ctx 上传进来的那几个能力。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import plugin from '../lib/index.js'

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

  async function request(method, path, { body, token = TOKEN, host = '127.0.0.1:19387' } = {}) {
    const handler = routes.get(`exact:${path}`)
    if (handler === undefined) throw new Error(`no route ${path}`)
    const headers = { host }
    if (token !== null) headers['x-headorbit-token'] = token
    const req = {
      method,
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
  const file = path.join(os.homedir(), '.dsh-airpod-control', 'token')
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
  assert.equal(host.askApproval({ callId: 'call-2' }), undefined)
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
  assert.equal(
    tooMany.askQuestion({
      questions: [
        {
          id: 'q1',
          question: '选一个',
          options: Array.from({ length: 9 }, (_, index) => ({ label: `选项${String(index + 1)}` })),
        },
      ],
    }),
    undefined,
  )

  const off = start({ claimQuestions: 'off' })
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
  assert.equal(host.askApproval(), undefined)
  assert.equal(host.askQuestion(), undefined)
  assert.equal(host.browserCalls(), 0)
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
  assert.equal(offline.askApproval(), undefined)
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
