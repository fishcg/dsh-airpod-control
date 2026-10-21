# dsh-head-gesture

用头部手势回答 DeepSeek Harness 的两件事，同一套动作：

| 场景 | 点头 | 摇头 |
| --- | --- | --- |
| **权限许可**（approval） | 允许（`allowed-once`） | 拒绝 |
| **模型提问**（`ask_user_question`） | 是 / 继续 / 全选 | 否 / 取消 / 全不选 |

手势由 [HeadOrbit](https://github.com/Cogria-AI/HeadOrbit)（AirPods 头部追踪的 macOS 菜单栏 App）识别，
通过本机回环 HTTP 送到这个插件；插件分别注册成审批回答者与提问回答者（approval / user-questions answerer）。

- **手势和网页按钮同时有效，谁先到算谁的**：认领请求的同时也调用 `next()`，所以网页那张卡片照常
  渲染；你在页面上点「允许」和做一个手势是在赛跑。没有回答者时 DSH 本来就是 fail closed，本插件不改变这个性质。
- **只有 HeadOrbit 在线时才抢答**：HeadOrbit 每 0.75 秒 `GET /state`，这就是它的心跳；超过
  `aliveWindowMs` 没动静（没开 App / 没戴耳机 / 没在追踪）时插件一行都不碰，网页卡片完全按原样工作。
- 许可到时间没人做手势（默认 **10 分钟**）按**拒绝**收场，不会把工具调用无限挂着；这期间页面上那张
  卡片一直有效，在页面上点按钮和做手势是同一场比赛。
- 提问答不了的手势组合（多于 8 个选项、或一批里有多选题答不了）、以及 `claimQuestions: off` 时，整个提问都不认领，
  交给网页那张卡片按原样处理。
- **手势答完的卡片会自动消失**：插件带一个浏览器半区（`lib/client.js`，`package.json` 里的 `dsh.client`
  声明）。DSH 结算请求时只会结束宿主那一份，网页上的卡片不会自己收到通知，所以这个半区每 0.7 秒看一次
  「有没有正在等答的卡片」，只在有的时候读一次 `/last-decision`，发现这次请求已经被手势/按键结算过
  （结算时间不早于卡片出现的时刻、类型对得上）就把卡片撤掉。
- 浏览器半区是手写 CJS（`window.__ModuleLoader__.load({ id, factory })`、零构建、不 import 任何
  `@deepseek-ai` 值），改完**要重启 DSH** 才会重新下发；宿主那半边的改动同理。

## 安装（本机 profile）

在 `~/.dsh/profiles/<profile>/` 下：

```jsonc
// package.json
"dependencies": { "dsh-head-gesture": "link:/Users/fish/dsh-head-gesture" },
"dsh": { "profile": { "bundles": ["...", "dsh-head-gesture"] } }
```

```yaml
# cordis.patch.yml —— 插件那一行由它自己的 bundle 补丁插入，这里只覆盖本机取值
- id: dsh-head-gesture
  config:
    enabled: true
    token: <和 HeadOrbit 里填的同一个随机串>
```

然后 `CI=true pnpm install` 并重启 DSH。（`package.json` 里的依赖是 `link:` 时不用重新装，
但 profile 的 `dsh.profile.bundles` 变了就一定要重启，bundle 层是启动时组装的。）

> 插件包自己的 `package.json` 必须声明 `dsh.bundle.patch`，否则 DSH 会**静默跳过**这一行：
> 启动日志里只有一句 `dsh: skipping profile bundle "<name>": ... declares no dsh.bundle in its package.json`，
> 表现就是路由 404、像没装一样。`node .../dsh/lib/bin.js --profile web --dump-config` 可以核对最终组合树。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 关着的时候什么都不注册，等于没装 |
| `token` | `''` | 共享密钥。**为空就完全不认领请求**；非空时要求请求带 `X-HeadOrbit-Token` |
| `nodAllows` | `true` | `false` 则反过来：摇头＝允许、点头＝拒绝（提问也一起反过来） |
| `claimQuestions` | `'auto'` | `'off'` 则完全不接模型的提问，只回答权限许可 |
| `questionTimeoutMs` | `600000` | 提问没人答时多久按「超时」结算（工具据此返回 pending，不卡死这一轮） |
| `yesLabel` / `noLabel` | `'是'` / `'否'` | 自由文本提问没有选项时，点头/摇头落成的自定义回答 |
| `timeoutMs` | `600000` | 一直没人做手势时多久按「拒绝」结算 |
| `aliveWindowMs` | `6000` | 多久没收到 HeadOrbit 的心跳就认为它不在线，从而完全不抢答 |
| `requireHeadOrbit` | `true` | `false` 时不看心跳、永远抢答。**用 curl 验一遍、或 HeadOrbit 还没构建好时**开它 |
| `debounceMs` | `600` | 两次手势之间的最小间隔，防止识别抖动给两个答案 |
| `gestureTtlMs` | `2000` | 手势自带 `ttlMs` 的默认上限 |
| `logHeadlines` | `true` | 把 asked / answered / gesture 摘要写进宿主日志 |
| `eventLimit` | `50` | `/events` 保留的流水条数 |
| `maxParamsChars` | `500` | `/state` 里回显工具参数的长度上限 |

## 端点

全部挂在 `/dsh-head-gesture` 前缀下，复用宿主已有的 webServer 路由（因此只听 127.0.0.1）。
除 Host / 同站检查之外，都需要 `X-HeadOrbit-Token`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/state` | `{ waiting, kind, label, question?, deadlineAt, canAnswer, headOrbit, ... }`，HeadOrbit 靠它决定要不要发手势，同时它本身就是心跳 |
| `GET` | `/health` | 自检：`{ ok, hasToken, hasApprovalAnswerer, hasQuestionAnswerer, headOrbitAlive, answered, ignored }`（不回报 token 本身） |
| `GET` | `/events` | 最近的事件流水，排查用 |
| `GET` | `/last-decision` | **免 token**：最近一次手势/按键结算了哪个请求（浏览器半区据此撤卡片） |
| `GET` | `/cursor` | **免 token**：当前光标落在第几项（只回序号与那一项的文字） |
| `POST` | `/gesture` | `{ "gesture": "nod" \| "shake", "ttlMs": 2000, "requestId"?: "q1" }` |
| `POST` | `/answer` | `{ "decision": "allow" \| "reject" \| "select:N", "requestId"?: "q1" }`，没有耳机时的等价入口；`select:N` 直接点名第 N 个选项 |

`/state` 里 `kind` 是 `"approval"` 或 `"question"`；等提问时 `question` 会带上题目与选项
（`{ requestId, label, count, questions, deadlineAt }`）。浏览器半区拿 `question.cursor`
在网页卡片上把「现在点头会选中哪一项」圈出来。
带 `requestId` 的调用是网页卡片回的答案，id 对不上会得到 `409 { stale: true }` —— 不会把旧卡片的选择
安到下一个问题上。

返回值里 `accepted: true` 才表示这次手势真的被采纳了：

端口就是 DSH 自己的 GUI 端口（`dsh web` 启动时打印的那个）；插件不开新端口。

```console
$ curl -s -H "X-HeadOrbit-Token: $TOKEN" http://127.0.0.1:$DSH_WEB_PORT/dsh-head-gesture/health
{"ok":true,"plugin":"dsh-head-gesture","version":"0.1.1","hasToken":true,"hasApprovalAnswerer":true,"hasQuestionAnswerer":true,"headOrbitAlive":true,"headOrbitWindowMs":6000,"waiting":false,"waitingKind":null,"answered":3,"ignored":0}
```

## 安全性（值得说清楚）

这是「从本机网络改变一次授权决定」，所以：

- 不自己开端口，复用宿主 webServer，天然只听回环；
- 必须有共享密钥，本机其它进程即使能访问这个端口也伪造不了答案；
- 只回答正在等待中的那一次请求，一次请求只结算一次，过期手势不采纳；
- 拒绝 Host 不是回环、`Sec-Fetch-Site: cross-site` 的请求；
- **它仍然是便利层，不是安全边界**：token 存在 profile 配置里，本机任何能读该文件的进程都能拿到。
  真正的护栏是 DSH 自身的审批语义（`allowed-once` 只授权这一次工具调用）。

## 测试

```bash
node --test test/plugin.test.js  # 45 个用例：许可/提问两条路、在线判定、与网页卡片赛跑、超时、中止、鉴权、卸载
node scripts/demo.js             # 起一个假宿主，走一遍「点头＝允许」+「点头＝同意部署」
node scripts/demo.js --reject    # 摇头那条路
node scripts/demo.js --select=0  # 没有耳机时的等价入口：直接选第 0 个选项
```

选项映射的规则（`gestureOptionIndexes`，lib/index.js:80）：模型用 `intent.approve` 指明「同意」是哪个
label 时以它为准（`dsh-client-ui-user-questions` 找「同意」按钮用的也是同一条规则）；否则按选项文字里
的肯定/否定词猜；再不然就「点头＝第一项、摇头＝最后一项」。

**选项多于两个**（只有一个问题、不是多选、选项不超过 8 个）时改成「摇头切换、点头确认」：光标初始停在
第一项（`intent.approve` 存在时停在「同意」那一项），每摇一次头往后挪一项、到底再回到第一项，点头＝确认
当前项。不做自动落定——用户点头之前问题一直挂着，由 `questionTimeoutMs` 兜底。光标位置通过 `/state` 的
`question.cursor` / `question.selectedLabel` 暴露；浏览器半区据此在网页卡片的选项按钮上**画高亮边框**，
鼠标点那一项就是直接跳到它（`POST /cursor` 带 `{ index }`）。
两个选项的问题仍然是一步到位（点头＝同意、摇头＝不同意），和审批保持同一套方向语义。

## 已知边界

- 提问被手势认领后，网页卡片仍然会渲染（我们同时调了 `next()`），所以两边都能答；
  但**卡片上的按钮和手势是两条独立的路**，卡片一旦点过，手势就作废（`ignored` 计数 +1，流水里有记录）。
- 一次只等一个请求：手势优先级是「提问 > 许可」，两个同时挂着时先答提问，许可继续等下一次手势。
- 提问超时按 `ASK_TIMED_OUT` 抛，工具返回 pending（不是「跳过」）；这之后用户仍可在 DSH 里补答。
