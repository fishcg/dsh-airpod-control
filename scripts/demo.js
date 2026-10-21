/**
 * 不用耳机也能验一遍的端到端演示。
 *
 * 起一个本地 HTTP 服务，用插件的真身注册它那几个路由，然后依次：
 *   ① /health 自检  ② 模拟 DSH 发起一次 Bash 审批（点头之前一直挂着）
 *   ③ /state 看「有人在等」  ④ POST 一个 nod  ⑤ 打印最终 outcome
 *
 * 用 `--reject` 可以改走摇头；`--curl` 只打印 curl 命令，让你自己敲。
 */

import http from 'node:http'

import plugin from '../lib/index.js'

const TOKEN = 'demo-token'
const PORT = Number(process.env.PORT ?? 47823)
const mode = process.argv.includes('--reject') ? 'shake' : 'nod'
const printCurlOnly = process.argv.includes('--curl')
/** 直接选某一道题的第 N 个选项（0 起），不需要耳机 —— 用来验「选择题映射」 */
const selectArg = process.argv.find((a) => a.startsWith('--select='))
const select = selectArg === undefined ? null : Number(selectArg.split('=')[1])

// —— 一个最小的假宿主：路由表 + 一个审批派发口，形状和真实宿主一致 ——
const routes = new Map()
const listeners = []
const cleanups = []

const ctx = {
  logger: { info: (line) => console.log(`  host: ${line}`), warn() {}, error() {} },
  on(name, listener) {
    listeners.push({ name, listener })
    return () => {}
  },
  inject(services, callback) {
    const dispose = callback({
      approval: {},
      userQuestions: {},
      webServer: {
        register(route) {
          routes.set(route.path, route.handler)
          return () => routes.delete(route.path)
        },
      },
    })
    if (typeof dispose === 'function') cleanups.push(dispose)
    return dispose
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return () => {}
  },
}

plugin.apply(ctx, { enabled: true, token: TOKEN, timeoutMs: 10_000, debounceMs: 0 })

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const handler = routes.get(path)
  if (handler === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  await handler(req, res)
})

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${PORT}/dsh-head-gesture`
console.log(`假宿主已起在 ${base}\n`)

if (printCurlOnly) {
  console.log(`curl -s -H "X-HeadOrbit-Token: ${TOKEN}" ${base}/health`)
  console.log(`curl -s -H "X-HeadOrbit-Token: ${TOKEN}" ${base}/state`)
  console.log(`curl -s -X POST -H "X-HeadOrbit-Token: ${TOKEN}" -H 'Content-Type: application/json' \\`)
  console.log(`     -d '{"gesture":"${mode}"}' ${base}/gesture`)
  server.close()
} else {
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { 'X-HeadOrbit-Token': TOKEN } })
    return res.json()
  }

  // 模拟 HeadOrbit 的心跳：真实 App 每 0.75 秒 GET 一次 /state，插件靠这个判断「耳机那边在线」，
  // 在线才抢答；不在线就一行都不碰，网页卡片照旧。所以演示里也得先敲一下。
  const beat = () => get('/state')

  // 把一次请求交给第一个愿意认领的监听器；没人认领就返回 undefined（真实宿主里等于 next()）
  const browserCalls = { n: 0 }
  const dispatch = async (name, request) => {
    for (const { name: registered, listener } of listeners) {
      if (registered !== name) continue
      // 「网页那张卡片」：真实宿主把 waterfall 继续往下走；这里用一个永远不结算的 Promise
      // 表示「人没去点按钮」。插件认领的同时也会调它 —— 所以卡片始终是活的。
      const next = () => {
        browserCalls.n += 1
        return new Promise(() => {})
      }
      const result = listener(request, next)
      if (result !== undefined) return { claimed: true, value: await result }
    }
    return { claimed: false, value: undefined }
  }

  const gesture = async () => {
    const res = await fetch(`${base}/gesture`, {
      method: 'POST',
      headers: { 'X-HeadOrbit-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gesture: mode, ttlMs: 2000 }),
    })
    return res.json()
  }

  const settle = (value, ok) =>
    value === undefined ? '（插件没认领，交给网页那张卡片）' : `${JSON.stringify(value)}${ok ? '   → 放行' : ''}`

  console.log('① /health')
  console.log('  ', JSON.stringify(await get('/health')))

  console.log('\n➊ HeadOrbit 的心跳（GET /state，真实 App 每 0.75 秒来一次）')
  await beat() // 第一次只是登记；插件从下一次轮询起才会认为它在线
  console.log('  ', JSON.stringify((await beat()).headOrbit))

  console.log('\n② 模拟一次需要许可的 Bash 调用（现在还没人回答，应该挂着）')
  const browserBefore = browserCalls.n
  const approval = dispatch('approval/request', {
    agent: { session: { id: 'demo-session' } },
    toolName: 'Bash',
    callId: 'call-demo',
    reason: 'sandbox',
    input: { command: 'rm -rf ./build && npm run build' },
  })
  await new Promise((r) => setTimeout(r, 50))
  console.log(`   （网页那张卡片同时也在渲染：插件替我们往下问了 ${browserCalls.n - browserBefore} 次）`)

  console.log('\n③ /state（HeadOrbit 就是靠这个决定要不要发手势）')
  console.log('  ', JSON.stringify(await get('/state')))

  console.log(`\n④ 做一个「${mode === 'nod' ? '点头' : '摇头'}」`)
  console.log('  ', JSON.stringify(await gesture()))

  const approvalDone = await approval
  console.log(`\n⑤ 审批结果 = ${settle(approvalDone.value, approvalDone.value === 'allowed-once')}`)

  console.log('\n⑥ 模拟模型的一次提问（计划的审批式提问：intent 指出了哪个选项算「同意」）')
  const question = dispatch('user-questions/request', {
    agent: { session: { id: 'demo-session' } },
    questions: [
      {
        id: 'q1',
        header: '部署',
        question: '现在就把这个版本发到生产吗？',
        // intent 的形状照真实 DSH 抄：{ kind: 'plan-review', approve: <「同意」那个选项的 label> }
        intent: { kind: 'plan-review', approve: '直接发' },
        options: [{ label: '先跑测试' }, { label: '直接发' }],
      },
    ],
  })
  await new Promise((r) => setTimeout(r, 50))
  console.log('  ', JSON.stringify(await get('/state')))

  let questionDone
  if (select === null) {
    console.log(`\n⑦ 再做一个「${mode === 'nod' ? '点头' : '摇头'}」来回答这个提问`)
    console.log('  ', JSON.stringify(await gesture()))
    questionDone = await question
  } else {
    console.log(`\n⑦ 没有耳机时的等价入口：直接选第 ${select} 个选项`)
    const res = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'X-HeadOrbit-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: `select:${select}` }),
    })
    console.log('  ', JSON.stringify(await res.json()))
    questionDone = await question
  }
  console.log(`\n⑧ 提问答案 = ${settle(questionDone.value, false)}`)

  console.log('\n事件流水：')
  for (const event of (await get('/events')).events) console.log('  ', JSON.stringify(event))

  server.close()
  for (const cleanup of cleanups) cleanup()
  // 脚本里没有别的定时器了，但别让一个漏掉的 socket 把进程挂住
  process.exit(0)
}
