/**
 * HeadOrbit 的「一键安装 + 自动配置」——让用户不用手动下载、不用手填端口和 token。
 *
 * 全部动作都是固定参数的本机命令（defaults / ditto / open / pgrep），没有把请求内容拼进
 * shell；能被调用的前提是回环 Host + 同站请求（见 index.js 的 /setup 路由）。
 *
 * 安装位置选 ~/Applications：这是用户自己的工作区，不需要管理员权限，也不需要审批。
 * HeadOrbit 需要的「动作与健身」权限由系统在它第一次读耳机传感器时弹出，插件做的是
 * 把它引导到正确的系统设置页，并把「现在到底缺哪一步」说清楚。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const run = promisify(execFile)

export const APP_PATH = path.join(os.homedir(), 'Applications', 'HeadOrbit.app')
export const STATE_DIR = path.join(os.homedir(), '.dsh-airpod-control')
export const TOKEN_FILE = path.join(STATE_DIR, 'token')
export const BUNDLE_ID = 'com.cogria.HeadOrbit'
export const BRIDGE_KEY = 'dsh.bridge.v1'
/** 默认的发布物：用户自己的 fork 里挂的 release（.app 压缩包） */
export const DEFAULT_DOWNLOAD_URL =
  'https://github.com/fishcg/HeadOrbit-dsh/releases/latest/download/HeadOrbit.zip'
/** 系统设置里的「动作与健身」隐私页 */
export const MOTION_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Motion'

/** 生成/复用共享 token。token 落在 ~/.dsh-airpod-control/token，profile 里不用手填。 */
export async function loadOrCreateToken() {
  const sync = tryLoadOrCreateTokenSync()
  if (sync !== '') return sync
  return loadOrCreateTokenAsync()
}

/**
 * 同步版本：插件在 apply() 里注册回答者之前就要知道「有没有 token」，
 * 那一步不能等异步。读不到就现生成一个。
 */
export function loadOrCreateTokenSync() {
  const token = tryLoadOrCreateTokenSync()
  if (token !== '') return token
  const fresh = crypto.randomBytes(24).toString('base64url')
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(TOKEN_FILE, `${fresh}\n`, { mode: 0o600 })
  return fresh
}

function tryLoadOrCreateTokenSync() {
  try {
    if (!existsSync(TOKEN_FILE)) return ''
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    return existing.length >= 16 ? existing : ''
  } catch {
    return ''
  }
}

async function loadOrCreateTokenAsync() {
  try {
    const existing = (await fs.readFile(TOKEN_FILE, 'utf8')).trim()
    if (existing.length >= 16) return existing
  } catch {
    // 没有就建一个
  }
  const token = crypto.randomBytes(24).toString('base64url')
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 })
  return token
}

/** ~/Applications/HeadOrbit.app 在不在 */
export async function appInstalled(appPath = APP_PATH) {
  // 装在别处但正在跑（比如用户自己从 GitHub 下的），也算装好了 —— 不要反复弹安装卡片；
  // 这种情况下 runSetup 只做「写配置 + 启动 + 等心跳」，不会覆盖用户那份。
  if (await appRunning()) return true
  try {
    await fs.access(path.join(appPath, 'Contents', 'MacOS', 'HeadOrbit'))
    return true
  } catch {
    return false
  }
}

/** 进程在不在（pgrep 不依赖 ps，沙箱里也能用） */
export async function appRunning() {
  try {
    const { stdout } = await run('/usr/bin/pgrep', ['-f', 'HeadOrbit.app/Contents/MacOS/HeadOrbit'])
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

/** 读 HeadOrbit 当前存的桥接配置（没有就返回 null） */
export async function readBridgeConfig() {
  // `defaults read` 对 data 值只打前 64 字节（中间是 `...`），所以改从偏好文件读：
  // plutil 转 xml1 后拿 <data> 的 base64，再解出 JSON。
  const plist = path.join(os.homedir(), 'Library', 'Preferences', `${BUNDLE_ID}.plist`)
  try {
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', plist])
    const match = new RegExp(`<key>${BRIDGE_KEY.replace(/\./g, '\\.')}</key>\\s*<data>([\\s\\S]*?)</data>`).exec(stdout)
    if (match === null) return null
    const base64 = match[1].replace(/\s/g, '')
    if (base64 === '') return null
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** 把端口和 token 写进 HeadOrbit 的偏好（它启动时读这份 JSON） */
export async function writeBridgeConfig({ port, token }) {
  const json = JSON.stringify({ isEnabled: true, port, token })
  const hex = Buffer.from(json, 'utf8').toString('hex')
  await run('/usr/bin/defaults', ['write', BUNDLE_ID, BRIDGE_KEY, '-data', hex])
  return JSON.parse(json)
}

/** 下载并安装到 ~/Applications（覆盖旧版本） */
export async function downloadAndInstall({ url = DEFAULT_DOWNLOAD_URL, appPath = APP_PATH, log } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'headorbit-'))
  try {
    log?.(`download ${url}`)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const zip = path.join(tmp, 'HeadOrbit.zip')
    await fs.writeFile(zip, Buffer.from(await res.arrayBuffer()))
    log?.(`downloaded ${(await fs.stat(zip)).size} bytes`)

    const unpacked = path.join(tmp, 'unpacked')
    await fs.mkdir(unpacked, { recursive: true })
    await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
    const found = await findApp(unpacked)
    if (found === null) throw new Error('压缩包里没有 HeadOrbit.app')
    log?.(`unpacked ${found}`)

    await fs.mkdir(path.dirname(appPath), { recursive: true })
    await fs.rm(appPath, { recursive: true, force: true })
    await run('/usr/bin/ditto', [found, appPath])
    // 从网上下来的包可能带隔离属性；本机自签的 App 带它会被 Gatekeeper 拦住
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath]).catch(() => {})
    return appPath
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function findApp(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) return path.join(dir, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = await findApp(path.join(dir, entry.name))
    if (nested !== null) return nested
  }
  return null
}

/** 启动 App（已经在跑就不动它） */
export async function launchApp(appPath = APP_PATH) {
  if (await appRunning()) return false
  await run('/usr/bin/open', ['-a', appPath])
  return true
}

/** 打开系统设置的「动作与健身」隐私页，让用户给 HeadOrbit 打勾 */
export async function openMotionPane() {
  await run('/usr/bin/open', [MOTION_PANE])
  return MOTION_PANE
}

/**
 * 一键配置：装 App（可选）→ 写端口/token → 启动 → 等心跳。
 * steps 是给界面显示的有序状态，任何一步失败都带着可读的 detail 返回。
 */
export async function runSetup({
  port,
  token,
  downloadUrl,
  appPath = APP_PATH,
  reinstall = false,
  alive = async () => false,
  log,
} = {}) {
  const steps = []
  const push = (id, status, detail) => {
    steps.push({ id, status, detail })
    log?.(`setup ${id} ${status}${detail ? `: ${detail}` : ''}`)
  }

  let installed = await appInstalled(appPath)
  if (!installed) {
    push('app', 'running', '正在下载 HeadOrbit…')
    try {
      await downloadAndInstall({ url: downloadUrl, appPath, log })
      installed = true
      push('app', 'done', appPath)
    } catch (error) {
      push('app', 'failed', error instanceof Error ? error.message : String(error))
      return { ok: false, steps }
    }
  } else if (reinstall) {
    push('app', 'running', '正在更新 HeadOrbit…')
    try {
      await downloadAndInstall({ url: downloadUrl, appPath, log })
      push('app', 'done', appPath)
    } catch (error) {
      push('app', 'failed', error instanceof Error ? error.message : String(error))
      return { ok: false, steps }
    }
  } else {
    push('app', 'done', `已安装：${appPath}`)
  }

  try {
    const written = await writeBridgeConfig({ port, token })
    push('config', 'done', `端口 ${written.port}，token ${token.slice(0, 6)}…`)
  } catch (error) {
    push('config', 'failed', error instanceof Error ? error.message : String(error))
    return { ok: false, steps }
  }

  try {
    const launched = await launchApp(appPath)
    push('launch', 'done', launched ? '已启动 HeadOrbit（菜单栏出现图标）' : 'HeadOrbit 已经在运行')
  } catch (error) {
    push('launch', 'failed', error instanceof Error ? error.message : String(error))
    return { ok: false, steps }
  }

  push('wait', 'running', '等待 HeadOrbit 连上插件…')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await alive()) {
      push('wait', 'done', '已连上')
      push(
        'permissions',
        'todo',
        '戴上 AirPods，第一次点头时系统会问「动作与健身」权限；没弹或者点错了，用下面的按钮去系统设置里打勾',
      )
      return { ok: true, steps }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  push(
    'wait',
    'waiting',
    'HeadOrbit 还没连上：戴上 AirPods 后它会开始追踪并上报心跳；如果它一直在运行却连不上，检查端口是否一致',
  )
  push('permissions', 'todo', '还需要在系统设置里给 HeadOrbit 打开「动作与健身」')
  return { ok: false, steps }
}
