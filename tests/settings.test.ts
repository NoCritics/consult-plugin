import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { SETTINGS_CASES } from './fixtures/settings-cases.mjs'
import { callLimitMs, frontmatterWarnings, loadConsultSettings, localConfigured, parseFrontmatter, runnerInUse, toConsultSettings } from '../hooks/mod/settings'

const DEFAULTS = {
  timeout_ms: 180000,
  codex_timeout_floor_ms: 600000,
  agy_image_timeout_ms: 300000,
  codex_image_timeout_ms: 300000,
  notify_after_s: 120,
  history_size: 50,
  local_slow_floor_ms: 1200000,
}

// The slice of a plugin's $ that loadConsultSettings uses. The test kit's own
// $ is the engine's call-site form, so a unit taking a plugin's $ gets this.
function pluginDollar(world: { cwd: string; env: Record<string, string>; files: Record<string, string> }): EngineInterface {
  const fake = {
    plugin: { name: 'consult', root: 'C:/plugin' },
    session: { cwd: async () => world.cwd },
    env: { get: async (name: string) => world.env[name] },
    fs: {
      exists: async (path: string) => path in world.files,
      read: async (path: string) => {
        const text = world.files[path]
        if (text === undefined) throw new Error(`ENOENT ${path}`)
        return text
      },
    },
  }
  return fake as unknown as EngineInterface
}

function settingsFrom(raw: Record<string, unknown>) {
  return toConsultSettings(raw, DEFAULTS)
}

describe('settings', () => {
  test('parseFrontmatter matches every shared case', () => {
    for (const one of SETTINGS_CASES) {
      const parsed = parseFrontmatter(one.text)
      for (const key of Object.keys(one.expect.raw)) {
        expect(parsed[key], `${one.name}: ${key}`).toEqual(one.expect.raw[key])
      }
      if (Object.keys(one.expect.raw).length === 0) {
        expect(parsed, one.name).toEqual({})
      }
    }
  })

  test('frontmatterWarnings and runnerInUse match every shared case', () => {
    for (const one of SETTINGS_CASES) {
      expect(frontmatterWarnings(one.text), one.name).toEqual(one.expect.warnings ?? [])
      expect(runnerInUse(settingsFrom(parseFrontmatter(one.text))), one.name).toBe(one.expect.runner ?? null)
    }
  })

  test('delegate keys: known in the global file, warned about in a project file, unknown ones flagged', () => {
    expect(frontmatterWarnings('---\ndelegate.on_close: keep\n---\n')).toEqual([])
    expect(frontmatterWarnings('---\ndelegate.on_close: keep\n---\n', true)).toEqual([
      'line 2: ignored `delegate.on_close`: delegate settings are global-only (~/.claude/consult.local.md)',
    ])
    expect(frontmatterWarnings('---\ndelegate.colour: red\n---\n')).toEqual(['line 2: unknown setting `delegate.colour`'])
    expect(frontmatterWarnings('---\ndelegate.fence.codex: full\n---\n', true)).toEqual([
      'line 2: ignored `delegate.fence.codex`: delegate settings are global-only (~/.claude/consult.local.md)',
    ])
  })

  test('loadConsultSettings: delegate settings come from the global file only', async () => {
    const world = {
      cwd: 'C:/proj',
      env: { USERPROFILE: 'C:/home' },
      files: {
        'C:/proj/.claude/consult.local.md': '---\ndelegate.on_close: keep\ntimeout_ms: 300000\n---\n',
        'C:/home/.claude/consult.local.md': '---\ndelegate.time_limit_min: 60\n---\n',
      } as Record<string, string>,
    }
    const settings = await loadConsultSettings(pluginDollar(world))
    expect(settings.raw['delegate.on_close']).toBeUndefined()
    expect(settings.raw['delegate.time_limit_min']).toBe(60)
    expect(settings.raw.timeout_ms).toBe(300000)
  })

  test('indented lines are not read', () => {
    expect(parseFrontmatter('---\nllama-swap:\n  fast: x\n---\n').fast).toBeUndefined()
  })

  test('loadConsultSettings: runner settings come from the global file only', async () => {
    const files: Record<string, string> = {
      'C:/Users/me/.claude/consult.local.md': '---\nlocal_runner: llama-swap\nllama-swap.default: qwen3.6-35b-a3b\ntimeout_ms: 600000\n---\n',
      'C:/proj/.claude/consult.local.md': '---\ntimeout_ms: 300000\nlocal_runner: ollama\n---\n',
    }
    const $ = pluginDollar({ cwd: 'C:/proj', env: { USERPROFILE: 'C:/Users/me' }, files })
    const settings = await loadConsultSettings($)
    expect(settings.raw.timeout_ms).toBe(300000)
    expect(runnerInUse(settings)).toBe('llama-swap')
    expect(settings.raw['llama-swap.default']).toBe('qwen3.6-35b-a3b')
    expect(localConfigured(settings)).toBe(true)
  })

  test('localConfigured: a runner, or 0.11.0 local_model, or neither', () => {
    expect(localConfigured(settingsFrom({ local_runner: 'llama-swap' }))).toBe(true)
    expect(localConfigured(settingsFrom({ local_model: 'qwen3.5:4b' }))).toBe(true)
    expect(localConfigured(settingsFrom({ local_runner: 'nonsense' }))).toBe(false)
    expect(localConfigured(settingsFrom({ timeout_ms: 600000 }))).toBe(false)
  })

  test('toConsultSettings applies ranges and defaults', () => {
    for (const one of SETTINGS_CASES) {
      const settings = settingsFrom(parseFrontmatter(one.text))
      expect(settings.notifyAfterS, one.name).toBe(one.expect.notifyAfterS)
      expect(settings.historySize, one.name).toBe(one.expect.historySize)
      expect(settings.summaryModel, one.name).toBe(one.expect.summaryModel)
    }
  })

  test('callLimitMs: timeout_s wins over everything', () => {
    const settings = settingsFrom({ codex_timeout_ms: 300000 })
    expect(callLimitMs('ask_codex', { prompt: 'x', timeout_s: 90 }, settings, DEFAULTS)).toBe(90000)
    expect(callLimitMs('agy_generate_image', { prompt: 'x', timeout_s: 600 }, settings, DEFAULTS)).toBe(600000)
  })

  test('callLimitMs: codex floor', () => {
    expect(callLimitMs('ask_codex', {}, settingsFrom({ timeout_ms: 180000 }), DEFAULTS)).toBe(600000)
    expect(callLimitMs('ask_codex', {}, settingsFrom({ timeout_ms: 900000 }), DEFAULTS)).toBe(900000)
    expect(callLimitMs('ask_codex', {}, settingsFrom({ codex_timeout_ms: 300000 }), DEFAULTS)).toBe(300000)
    expect(callLimitMs('ask_codex', {}, settingsFrom({}), DEFAULTS)).toBe(600000)
  })

  test('callLimitMs: agy, image, local, gemini', () => {
    expect(callLimitMs('ask_agy', {}, settingsFrom({}), DEFAULTS)).toBe(180000)
    expect(callLimitMs('ask_agy', {}, settingsFrom({ agy_timeout_ms: 240000 }), DEFAULTS)).toBe(240000)
    expect(callLimitMs('ask_agy', {}, settingsFrom({ timeout_ms: 200000 }), DEFAULTS)).toBe(200000)
    expect(callLimitMs('agy_generate_image', {}, settingsFrom({}), DEFAULTS)).toBe(300000)
    expect(callLimitMs('agy_generate_image', {}, settingsFrom({ agy_image_timeout_ms: 420000 }), DEFAULTS)).toBe(420000)
    // Two minutes more per extra image, capped at 30 minutes, as the server does.
    expect(callLimitMs('agy_generate_image', { count: 4 }, settingsFrom({}), DEFAULTS)).toBe(660000)
    expect(callLimitMs('agy_generate_image', { count: 4 }, settingsFrom({ agy_image_timeout_ms: 1700000 }), DEFAULTS)).toBe(1800000)
    expect(callLimitMs('agy_generate_image', { count: 4, timeout_s: 600 }, settingsFrom({}), DEFAULTS)).toBe(600000)
    expect(callLimitMs('agy_generate_image', { count: 9 }, settingsFrom({}), DEFAULTS)).toBe(300000)
    expect(callLimitMs('codex_generate_image', {}, settingsFrom({}), DEFAULTS)).toBe(300000)
    expect(callLimitMs('codex_generate_image', {}, settingsFrom({ codex_image_timeout_ms: 420000 }), DEFAULTS)).toBe(420000)
    expect(callLimitMs('codex_generate_image', { count: 4 }, settingsFrom({}), DEFAULTS)).toBe(660000)
    expect(callLimitMs('codex_generate_image', { count: 4 }, settingsFrom({ codex_image_timeout_ms: 1700000 }), DEFAULTS)).toBe(1800000)
    expect(callLimitMs('codex_generate_image', { count: 4, timeout_s: 600 }, settingsFrom({}), DEFAULTS)).toBe(600000)
    expect(callLimitMs('codex_generate_image', { count: 9 }, settingsFrom({}), DEFAULTS)).toBe(300000)
    // agy's image setting never leaks into codex's.
    expect(callLimitMs('codex_generate_image', {}, settingsFrom({ agy_image_timeout_ms: 420000 }), DEFAULTS)).toBe(300000)
    expect(callLimitMs('ask_local', {}, settingsFrom({ local_timeout_ms: 60000 }), DEFAULTS)).toBe(60000)
    expect(callLimitMs('ask_gemini', {}, settingsFrom({ timeout_ms: 120000 }), DEFAULTS)).toBe(120000)
  })

  test('callLimitMs: local calls get the slow-model floor unless local_timeout_ms is set', () => {
    // The bar can't know the runner a call ends up on, or whether an Ollama
    // model fits the GPU, so it assumes the server's one floor (20 minutes,
    // llama-swap and non-fitting Ollama models alike): a bar that fills
    // slowly beats a backstop that settles a slow call that is still running.
    expect(callLimitMs('ask_local', {}, settingsFrom({ timeout_ms: 180000 }), DEFAULTS)).toBe(1200000)
    expect(callLimitMs('ask_local', {}, settingsFrom({ timeout_ms: 1500000 }), DEFAULTS)).toBe(1500000)
    expect(callLimitMs('ask_local', { runner: 'ollama' }, settingsFrom({ local_runner: 'llama-swap' }), DEFAULTS)).toBe(1200000)
    expect(callLimitMs('ask_local', {}, settingsFrom({ local_timeout_ms: 120000 }), DEFAULTS)).toBe(120000)
    expect(callLimitMs('ask_local', { timeout_s: 90 }, settingsFrom({}), DEFAULTS)).toBe(90000)
    expect(callLimitMs('council_vote', { participants: ['local'] }, settingsFrom({ timeout_ms: 180000 }), DEFAULTS)).toBe(2 * 1200000)
  })

  test('callLimitMs: an invalid setting is ignored, as the server does', () => {
    expect(callLimitMs('ask_agy', {}, settingsFrom({ agy_timeout_ms: -1 }), DEFAULTS)).toBe(180000)
    expect(callLimitMs('ask_agy', {}, settingsFrom({ timeout_ms: 'soon' }), DEFAULTS)).toBe(180000)
  })

  test('callLimitMs: chats follow their participant', () => {
    const settings = settingsFrom({ agy_timeout_ms: 240000 })
    expect(callLimitMs('consult_chat_send', { participant: 'codex' }, settings, DEFAULTS)).toBe(600000)
    expect(callLimitMs('consult_chat_start', { participant: 'agy' }, settings, DEFAULTS)).toBe(240000)
    expect(callLimitMs('consult_chat_start', { participant: 'gemini' }, settings, DEFAULTS)).toBe(180000)
  })

  test('callLimitMs: council spans two rounds of its longest member', () => {
    const settings = settingsFrom({ timeout_ms: 180000 })
    const args = { participants: ['claude', 'codex', 'agy'] }
    expect(callLimitMs('council_vote', args, settings, DEFAULTS)).toBe(2 * 600000)
    expect(callLimitMs('council_vote', { participants: ['claude', 'agy'] }, settingsFrom({ council_timeout_ms: 100000 }), DEFAULTS)).toBe(2 * 100000)
    expect(callLimitMs('council_vote', { timeout_s: 120 }, settings, DEFAULTS)).toBe(2 * 120000)
    expect(callLimitMs('council_vote', {}, settings, DEFAULTS)).toBe(2 * 600000)
  })

  test('loadConsultSettings: project file wins, then global, then defaults', async () => {
    const files: Record<string, string> = {
      'C:/plugin/mcp/lib/defaults.json': JSON.stringify({ ...DEFAULTS, notify_after_s: 90 }),
    }
    const $ = pluginDollar({ cwd: 'C:/proj', env: { USERPROFILE: 'C:/Users/me' }, files })

    let settings = await loadConsultSettings($)
    expect(settings.notifyAfterS).toBe(90)
    expect(settings.raw).toEqual({})

    files['C:/Users/me/.claude/consult.local.md'] = '---\nhistory_size: 10\n---\n'
    settings = await loadConsultSettings($)
    expect(settings.historySize).toBe(10)

    files['C:/proj/.claude/consult.local.md'] = '---\nhistory_size: 20\n---\n'
    settings = await loadConsultSettings($)
    expect(settings.historySize).toBe(20)
    expect(settings.raw).toEqual({ history_size: 20 })
  })

  test('loadConsultSettings: unreadable defaults mean built-in defaults', async () => {
    const $ = pluginDollar({ cwd: 'C:/proj', env: { HOME: '/home/me' }, files: {} })
    const settings = await loadConsultSettings($)
    expect(settings.notifyAfterS).toBe(120)
    expect(settings.historySize).toBe(50)
    expect(settings.defaults.timeout_ms).toBe(180000)
  })
})
