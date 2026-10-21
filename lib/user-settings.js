// 用户在 DSH 设置页里改的偏好：存在 ~/.dsh-airpod-control/settings.json。
//
// 为什么单独存一个文件：cordis.patch.yml 是「安装配置」，改它要理解插件系统；
// 这里只放「手感」——幅度、快捷键、去抖——用户点保存就生效，不用重启 DSH。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 和 installer.js 用同一个覆盖变量：测试跑起来才不会写到用户真实的 settings.json
export const STATE_DIR = process.env.DSH_AIRPOD_CONTROL_STATE || path.join(os.homedir(), '.dsh-airpod-control')
export const USER_SETTINGS_FILE = path.join(STATE_DIR, 'settings.json')

/** 每个字段的取值范围；null 表示「用户没设过，用 App 自己算出来的值」 */
export const LIMITS = {
  unitNod: [8, 22],
  unitTurn: [12, 32],
  debounceMs: [0, 5_000],
}

export const SHORTCUT_MODES = ['arrows', 'ctrl-space', 'off']
/** 界面语言：auto = 跟系统，其余是用户明确指定 */
export const LANGUAGES = ['auto', 'zh', 'en']

/** null / undefined / 空串 = 「没设过」，不能当 0 处理（否则会被夹到下限） */
function clamp(value, low, high) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(high, Math.max(low, Math.round(n)))
}

/**
 * 读用户偏好。文件不存在、损坏、字段非法都按「没设过」处理——
 * 设置页永远能打开，不会因为一个坏 JSON 把插件弄挂。
 */
export function loadUserSettings() {
  const empty = {
    unitNod: null,
    unitTurn: null,
    voiceShortcut: 'arrows',
    cursorHighlight: true,
    debounceMs: null,
    requireHeadOrbit: null,
    language: 'auto',
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(USER_SETTINGS_FILE, 'utf8'))
  } catch {
    return empty
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty

  return {
    unitNod: clamp(raw.unitNod, ...LIMITS.unitNod),
    unitTurn: clamp(raw.unitTurn, ...LIMITS.unitTurn),
    voiceShortcut: SHORTCUT_MODES.includes(raw.voiceShortcut) ? raw.voiceShortcut : 'arrows',
    cursorHighlight: raw.cursorHighlight !== false,
    debounceMs: clamp(raw.debounceMs, ...LIMITS.debounceMs),
    requireHeadOrbit: typeof raw.requireHeadOrbit === 'boolean' ? raw.requireHeadOrbit : null,
    language: LANGUAGES.includes(raw.language) ? raw.language : 'auto',
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON 把设置页弄坏 */
export function saveUserSettings(next) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const body = JSON.stringify(next, null, 2) + '\n'
  const tmp = `${USER_SETTINGS_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, { mode: 0o600 })
  fs.renameSync(tmp, USER_SETTINGS_FILE)
  return next
}

/**
 * 合并一次更新：只接受白名单字段，非法值直接丢掉（不报错、不写半套）。
 * 返回 { next, changed } —— changed 里是「这次真的改了的字段」。
 */
export function mergeUserSettings(current, patch) {
  const next = { ...current }
  const changed = {}
  if (patch === null || typeof patch !== 'object') return { next, changed }

  if ('unitNod' in patch) {
    const v = clamp(patch.unitNod, ...LIMITS.unitNod)
    if (v !== current.unitNod) {
      next.unitNod = v
      changed.unitNod = v
    }
  }
  if ('unitTurn' in patch) {
    const v = clamp(patch.unitTurn, ...LIMITS.unitTurn)
    if (v !== current.unitTurn) {
      next.unitTurn = v
      changed.unitTurn = v
    }
  }
  if ('voiceShortcut' in patch) {
    const v = SHORTCUT_MODES.includes(patch.voiceShortcut) ? patch.voiceShortcut : null
    if (v !== null && v !== current.voiceShortcut) {
      next.voiceShortcut = v
      changed.voiceShortcut = v
    }
  }
  if ('cursorHighlight' in patch) {
    const v = patch.cursorHighlight !== false
    if (v !== current.cursorHighlight) {
      next.cursorHighlight = v
      changed.cursorHighlight = v
    }
  }
  if ('debounceMs' in patch) {
    const v = clamp(patch.debounceMs, ...LIMITS.debounceMs)
    if (v !== current.debounceMs) {
      next.debounceMs = v
      changed.debounceMs = v
    }
  }
  if ('language' in patch) {
    const v = LANGUAGES.includes(patch.language) ? patch.language : null
    if (v !== null && v !== current.language) {
      next.language = v
      changed.language = v
    }
  }
  if ('requireHeadOrbit' in patch) {
    const v = typeof patch.requireHeadOrbit === 'boolean' ? patch.requireHeadOrbit : null
    if (v !== null && v !== current.requireHeadOrbit) {
      next.requireHeadOrbit = v
      changed.requireHeadOrbit = v
    }
  }
  return { next, changed }
}
