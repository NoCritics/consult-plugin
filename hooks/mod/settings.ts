import type { EngineInterface } from 'claude-code'

// The mod reads the same consult.local.md as the MCP server (project file
// first, then the global one) and the same defaults.json, so each call's
// progress bar spans the limit the server enforces.

export type Frontmatter = Record<string, string | number | boolean | null>

export type ConsultSettings = {
  raw: Record<string, unknown>
  defaults: Record<string, number>
  notifyAfterS: number
  historySize: number
  summaryModel: 'haiku' | null
}

// Used when defaults.json cannot be read: the same values it ships with.
export const BUILT_IN_DEFAULTS: Record<string, number> = {
  timeout_ms: 180000,
  codex_timeout_floor_ms: 600000,
  agy_image_timeout_ms: 300000,
  codex_image_timeout_ms: 300000,
  notify_after_s: 120,
  history_size: 50,
}

const TIMEOUT_S_MIN = 30
const TIMEOUT_S_MAX = 1800
const HISTORY_SIZE_MAX = 200

// Copies of the server's lists (mcp/lib/local-runners.js and settings.js'
// KNOWN_KEYS); a server unit test reads this file and holds them equal.
export const RUNNER_TYPES: string[] = ['ollama', 'llama-swap', 'lmstudio', 'llama-server', 'openai']
export const RUNNER_KEYS: string[] = ['url', 'key_env', 'start', 'default', 'fast', 'vision', 'vision_best', 'big']
export const KNOWN_KEYS: string[] = [
  'codex_model', 'codex_reasoning_effort', 'codex_sandbox', 'codex_timeout_ms', 'codex_hooks',
  'agy_model', 'agy_effort', 'agy_timeout_ms', 'agy_image_dir', 'agy_image_timeout_ms', 'agy_image_aspect_ratio',
  'codex_image_dir', 'codex_image_timeout_ms', 'codex_image_aspect_ratio',
  'gemini_model', 'gemini_approval_mode', 'claude_model',
  'local_base_url', 'local_model', 'local_api_key', 'local_temperature', 'local_reasoning_effort', 'local_timeout_ms',
  'local_image_max_edge', 'local_vram_mb', 'local_model_fast', 'local_model_vision', 'local_model_vision_best', 'local_model_big',
  'council_use_bare', 'council_timeout_ms', 'timeout_ms', 'log_calls',
  'notify_after_s', 'history_size', 'summary_model', 'local_runner',
]

// A key at the start of a line; indented lines are not read.
const KEY_LINE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/

function frontmatterLines(text: string): string[] | null {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return block ? (block[1] ?? '').split(/\r?\n/) : null
}

export function isRunnerKey(key: string): boolean {
  if (key === 'local_runner') return true
  const dot = key.indexOf('.')
  return dot > 0 && RUNNER_TYPES.includes(key.slice(0, dot))
}

// The delegate (background task) settings, global-only like the runner ones.
// Not in KNOWN_KEYS (the server holds that list equal to this one); the mod
// does not read them or check their values, the server does.
export const DELEGATE_KEYS: string[] = [
  'delegate.code', 'delegate.research', 'delegate.review', 'delegate.private',
  'delegate.local_at_once', 'delegate.on_close', 'delegate.time_limit_min',
]

export function isDelegateKey(key: string): boolean {
  return key.startsWith('delegate.')
}

function isGlobalOnlyKey(key: string): boolean {
  return isRunnerKey(key) || isDelegateKey(key)
}

// The same warnings as frontmatterWarnings in mcp/lib/settings.js; the shared
// fixture holds both to them. The mod shows none of them itself.
export function frontmatterWarnings(text: string, projectScope = false): string[] {
  const lines = frontmatterLines(text)
  if (lines === null) return []
  const warnings: string[] = []
  const runnerLines: string[] = []
  const seenAt = new Map<string, number>()
  let runnerChosen = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const lineNumber = index + 2
    if (/^\s*(#.*)?$/.test(line)) continue
    if (/^\s/.test(line)) {
      warnings.push(`line ${lineNumber}: indented lines aren't supported; write \`runner.key: value\``)
      continue
    }
    const found = KEY_LINE.exec(line)
    if (!found) continue
    const key = found[1] ?? ''
    const firstLine = seenAt.get(key)
    if (firstLine !== undefined) {
      warnings.push(`line ${lineNumber}: \`${key}\` is set again (line ${firstLine}); only the last one counts`)
      seenAt.set(key, lineNumber)
      continue
    }
    seenAt.set(key, lineNumber)
    if (projectScope && isGlobalOnlyKey(key)) {
      const kind = isRunnerKey(key) ? 'runner' : 'delegate'
      warnings.push(`line ${lineNumber}: ignored \`${key}\`: ${kind} settings are global-only (~/.claude/consult.local.md)`)
      continue
    }
    if (isDelegateKey(key)) {
      if (!DELEGATE_KEYS.includes(key)) warnings.push(`line ${lineNumber}: unknown setting \`${key}\``)
      continue
    }
    if (key === 'local_runner') {
      runnerChosen = true
      const value = (found[2] ?? '').replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2')
      if (value !== '' && value !== 'null' && !RUNNER_TYPES.includes(value)) {
        warnings.push(`line ${lineNumber}: \`local_runner\` must be one of ${RUNNER_TYPES.join(', ')}`)
      }
      continue
    }
    if (KNOWN_KEYS.includes(key)) continue
    const dot = key.indexOf('.')
    if (dot > 0) {
      const prefix = key.slice(0, dot)
      if (!RUNNER_TYPES.includes(prefix)) {
        warnings.push(`line ${lineNumber}: unknown runner \`${prefix}\` in \`${key}\``)
        continue
      }
      if (RUNNER_KEYS.includes(key.slice(dot + 1))) {
        runnerLines.push(key)
        continue
      }
    }
    warnings.push(`line ${lineNumber}: unknown setting \`${key}\``)
  }
  if (!projectScope && !runnerChosen && runnerLines.length > 0) {
    warnings.push(`\`local_runner\` isn't set, so the runner settings (${runnerLines.join(', ')}) are not used`)
  }
  return warnings
}

// The same rules as parseFrontmatter in mcp/lib/settings.js; the shared
// fixture tests/fixtures/settings-cases.mjs holds both to them.
export function parseFrontmatter(text: string): Frontmatter {
  const lines = frontmatterLines(text)
  if (lines === null) return {}
  const out: Frontmatter = {}
  for (const line of lines) {
    const pair = line.match(KEY_LINE)
    if (!pair) continue
    const key = pair[1] as string
    let value = pair[2] ?? ''
    const quoted = value.match(/^(['"])(.*?)\1/)
    if (quoted) {
      out[key] = quoted[2] ?? ''
      continue
    }
    value = value.replace(/\s+#.*$/, '').replace(/^#.*$/, '')
    if (value === '' || value.toLowerCase() === 'null') {
      out[key] = null
      continue
    }
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      out[key] = Number(value)
      continue
    }
    if (value === 'true' || value === 'false') {
      out[key] = value === 'true'
      continue
    }
    out[key] = value
  }
  return out
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

export function toConsultSettings(raw: Record<string, unknown>, defaults: Record<string, number>): ConsultSettings {
  const notify = raw.notify_after_s
  const history = raw.history_size
  return {
    raw,
    defaults,
    notifyAfterS: isWholeNumber(notify) && notify >= 0 ? notify : (defaults.notify_after_s ?? 120),
    historySize: isWholeNumber(history) && history >= 1 && history <= HISTORY_SIZE_MAX ? history : (defaults.history_size ?? 50),
    summaryModel: raw.summary_model === 'haiku' ? 'haiku' : null,
  }
}

async function readDefaults($: EngineInterface): Promise<Record<string, number>> {
  try {
    const text = await $.fs.read(`${$.plugin.root}/mcp/lib/defaults.json`)
    if (typeof text !== 'string') return BUILT_IN_DEFAULTS
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return BUILT_IN_DEFAULTS
    const merged: Record<string, number> = { ...BUILT_IN_DEFAULTS }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number') merged[key] = value
    }
    return merged
  } catch {
    return BUILT_IN_DEFAULTS
  }
}

async function readSettingsFile($: EngineInterface, path: string): Promise<Frontmatter | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return typeof text === 'string' ? parseFrontmatter(text) : {}
  } catch {
    return {}
  }
}

// As the server's loadSettings: the project file when it exists, else the
// global one; runner settings (local_runner, <runner>.*) always from the
// global file, and never from a project's.
async function readSettings($: EngineInterface): Promise<Frontmatter> {
  let projectPath: string | null = null
  try {
    projectPath = `${await $.session.cwd()}/.claude/consult.local.md`
  } catch {
    // no project file to read
  }
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const globalPath = home ? `${home}/.claude/consult.local.md` : null
  const global = globalPath === null ? null : await readSettingsFile($, globalPath)
  const project = projectPath === null || projectPath === globalPath ? null : await readSettingsFile($, projectPath)
  if (project === null) return global ?? {}
  const merged: Frontmatter = {}
  for (const [key, value] of Object.entries(project)) {
    if (!isGlobalOnlyKey(key)) merged[key] = value
  }
  for (const [key, value] of Object.entries(global ?? {})) {
    if (isGlobalOnlyKey(key)) merged[key] = value
  }
  return merged
}

export async function loadConsultSettings($: EngineInterface): Promise<ConsultSettings> {
  const defaults = await readDefaults($)
  const raw = await readSettings($)
  return toConsultSettings(raw, defaults)
}

export function runnerInUse(s: ConsultSettings): string | null {
  const runner = s.raw.local_runner
  return typeof runner === 'string' && RUNNER_TYPES.includes(runner) ? runner : null
}

// A runner chosen, or (the 0.11.0 way) a local_model: the server's localConfigured.
export function localConfigured(s: ConsultSettings): boolean {
  if (runnerInUse(s) !== null) return true
  return typeof s.raw.local_model === 'string' && s.raw.local_model !== ''
}

// A setting the server would drop (sanitize: not a positive number) is unset.
function positiveSetting(s: ConsultSettings, key: string): number | null {
  const value = s.raw[key]
  return typeof value === 'number' && value > 0 ? value : null
}

function baseTimeoutMs(s: ConsultSettings, defaults: Record<string, number>): number {
  return positiveSetting(s, 'timeout_ms') ?? defaults.timeout_ms ?? 180000
}

function timeoutFromArgs(args: Record<string, unknown>): number | null {
  const seconds = args.timeout_s
  if (typeof seconds !== 'number' || !(seconds >= TIMEOUT_S_MIN && seconds <= TIMEOUT_S_MAX)) return null
  return Math.round(seconds * 1000)
}

// One provider's limit with no timeout_s, given the base timeout_ms it falls
// back to (timeout_ms itself, or council_timeout_ms inside a council).
function providerLimitMs(provider: string, s: ConsultSettings, defaults: Record<string, number>, baseMs: number): number {
  if (provider === 'codex') {
    return positiveSetting(s, 'codex_timeout_ms') ?? Math.max(baseMs, defaults.codex_timeout_floor_ms ?? 600000)
  }
  if (provider === 'agy') return positiveSetting(s, 'agy_timeout_ms') ?? baseMs
  if (provider === 'local') {
    // The server gives every llama-swap call, and an Ollama model that doesn't
    // fit the GPU, at least the slow floor. The bar can't tell which runner or
    // model a call ends up on, so it always assumes the floor: overestimating
    // only fills the bar slowly, while
    // underestimating would let the backstop settle a slow call still running.
    return positiveSetting(s, 'local_timeout_ms') ?? Math.max(baseMs, defaults.local_slow_floor_ms ?? 1200000)
  }
  return baseMs
}

const COUNCIL_DEFAULT_MEMBERS = ['claude', 'codex', 'agy']

// As the servers' image timeouts: two minutes more per extra image, up to 30
// minutes. A count the server would refuse counts as one image.
function imageLimitMs(settingKey: string, args: Record<string, unknown>, s: ConsultSettings, defaults: Record<string, number>): number {
  const imageBase = positiveSetting(s, settingKey) ?? defaults[settingKey] ?? 300000
  const count = args.count
  const images = typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1
  return Math.min(imageBase + (images - 1) * 120000, 1800000)
}

export function callLimitMs(tool: string, args: Record<string, unknown>, s: ConsultSettings, defaults: Record<string, number>): number {
  const perCall = timeoutFromArgs(args)
  if (tool === 'council_vote') {
    // Two rounds: the members answer, then they judge each other.
    if (perCall !== null) return 2 * perCall
    const councilBase = positiveSetting(s, 'council_timeout_ms') ?? baseTimeoutMs(s, defaults)
    const members = Array.isArray(args.participants) && args.participants.length > 0 ? args.participants : COUNCIL_DEFAULT_MEMBERS
    let longest = 0
    for (const member of members) {
      longest = Math.max(longest, providerLimitMs(String(member), s, defaults, councilBase))
    }
    return 2 * longest
  }
  if (perCall !== null) return perCall
  if (tool === 'agy_generate_image') return imageLimitMs('agy_image_timeout_ms', args, s, defaults)
  if (tool === 'codex_generate_image') return imageLimitMs('codex_image_timeout_ms', args, s, defaults)
  const base = baseTimeoutMs(s, defaults)
  if (tool === 'ask_codex') return providerLimitMs('codex', s, defaults, base)
  if (tool === 'ask_agy') return providerLimitMs('agy', s, defaults, base)
  if (tool === 'ask_local') return providerLimitMs('local', s, defaults, base)
  if (tool === 'consult_chat_start' || tool === 'consult_chat_send') {
    // Chats have no local participant; anything but codex or agy runs on timeout_ms.
    const participant = String(args.participant ?? '')
    return participant === 'codex' || participant === 'agy' ? providerLimitMs(participant, s, defaults, base) : base
  }
  return base
}
