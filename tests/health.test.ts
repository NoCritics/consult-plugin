import { describe, expect, test } from 'claude-code/testing'

import type { Health } from '../types'
import * as fixtures from './fixtures/results'
import { CONSULT, answerConsult, world } from './world'
import { healthFromStatus, statusLine } from '../hooks/mod/health'

function health(overrides: Partial<Health['services']>, showStartLine: boolean): Health {
  return {
    services: {
      codex: { state: 'ok', reason: null },
      agy: { state: 'ok', reason: null },
      local: { state: 'absent', reason: null },
      ...overrides,
    },
    showStartLine,
  }
}

const OK_CODEX = { authenticated: true, exit_code: 0, details: 'Logged in' }
const OK_AGY = { authenticated: true, model_count: 3 }
const SIGNED_OUT_AGY = { authenticated: false, reason: 'error', details: 'auth required: please sign in' }

function slashes(path: string): string {
  return path.replace(/\\/g, '/')
}

describe('health', () => {
  test('statusLine while checking, at the start, when broken and otherwise', () => {
    expect(statusLine(health({ codex: { state: 'checking', reason: null }, agy: { state: 'checking', reason: null } }, true))).toBe('checking…')
    expect(statusLine(health({}, true))).toBe('codex ✓ agy ✓ local –')
    expect(statusLine(health({ agy: { state: 'broken', reason: 'x' }, local: { state: 'unknown', reason: null } }, true))).toBe('codex ✓ agy ✗ local ?')
    expect(statusLine(health({ agy: { state: 'broken', reason: 'not signed in — run agy once' } }, false))).toBe('agy ✗ not signed in — run agy once')
    expect(statusLine(health({}, false))).toBe(undefined)
  })

  test('a status check that failed without an answer is unknown, not signed out', () => {
    expect(healthFromStatus('codex', { authenticated: false, exit_code: null, details: 'timed out' })).toEqual({ state: 'unknown', reason: null })
    expect(healthFromStatus('codex', { authenticated: false, exit_code: 1, details: 'Not logged in' })).toEqual({ state: 'broken', reason: 'not signed in — run codex login' })
    expect(healthFromStatus('agy', { authenticated: false, reason: 'error', details: 'agy models timed out after 30000ms' })).toEqual({ state: 'unknown', reason: null })
    expect(healthFromStatus('agy', { authenticated: false, reason: 'error', details: 'Please sign in' })).toEqual({ state: 'broken', reason: 'not signed in — run agy once' })
  })

  test('a llama-swap that answers but wants its key is broken, not ok', () => {
    expect(healthFromStatus('local', { reachable: true, reason: 'needs_key' })).toEqual({ state: 'broken', reason: 'needs its key — run /consult:setlocal' })
    expect(healthFromStatus('local', { reachable: true, reason: 'key_rejected' })).toEqual({ state: 'broken', reason: 'key rejected' })
    expect(healthFromStatus('local', { reachable: true, reason: 'key_missing' })).toEqual({ state: 'broken', reason: 'key variable not set' })
    expect(healthFromStatus('local', { reachable: true, models: [] })).toEqual({ state: 'ok', reason: null })
  })

  test('a session with no person at the prompt runs no checks', async ($, on) => {
    const { clock, seen } = world(on)
    await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false })
    await clock.advance(20000)
    expect(seen.healthRuns).toEqual([])
  })

  test('an interactive start runs the status script after 2 s, never $.mcp.call, and shows the result', async ($, on) => {
    const { clock, seen } = world(on, { healthScript: { codex: OK_CODEX, agy: OK_AGY } })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    expect(seen.statuses.at(-1)).toBe('checking…')
    expect(seen.healthRuns).toEqual([])
    await clock.advance(2000)
    expect(seen.healthRuns.length).toBe(1)
    const argv = seen.healthRuns[0]?.argv ?? []
    expect(argv[0]).toBe('node')
    expect(slashes(argv[1] ?? '').endsWith('/hooks/scripts/health.js')).toBe(true)
    // The project goes as an argument, not as the working directory: a
    // node.exe planted in the project must not be what runs.
    expect(argv.slice(2)).toEqual(['C:/proj', 'codex', 'agy'])
    expect(slashes(seen.healthRuns[0]?.cwd ?? '')).toBe(slashes(argv[1] ?? '').replace(/\/hooks\/scripts\/health\.js$/, ''))
    expect(seen.mcpCalls).toEqual([])
    expect(seen.statuses.at(-1)).toBe('codex ✓ agy ✓ local –')
  })

  test('with local_model set, local is checked too', async ($, on) => {
    const { clock, seen } = world(on, {
      files: { 'C:/proj/.claude/consult.local.md': '---\nlocal_model: qwen3.5:9b\n---\n' },
      healthScript: { codex: OK_CODEX, agy: OK_AGY, local: { reachable: false, reason: 'unreachable' } },
    })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    expect(seen.healthRuns[0]?.argv.slice(2)).toEqual(['C:/proj', 'codex', 'agy', 'local'])
    expect(seen.statuses.at(-1)).toBe('codex ✓ agy ✓ local ✗')
  })

  test('with local_runner set in the global file, local is checked without local_model', async ($, on) => {
    const { clock, seen } = world(on, {
      files: { 'C:/Users/me/.claude/consult.local.md': '---\nlocal_runner: llama-swap\n---\n' },
      healthScript: { codex: OK_CODEX, agy: OK_AGY, local: { reachable: true, models: ['qwen3.5-4b'] } },
    })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    expect(seen.healthRuns[0]?.argv.slice(2)).toEqual(['C:/proj', 'codex', 'agy', 'local'])
  })

  test('a status script that never exits is drawn as ? after 15 s', async ($, on) => {
    const { clock, seen } = world(on, { healthScript: 'hang' })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    expect(seen.statuses.at(-1)).toBe('checking…')
    await clock.advance(15000)
    expect(seen.statuses.at(-1)).toBe('codex ? agy ? local –')
  })

  test('a service the script could not check is ?, the others still show', async ($, on) => {
    const { clock, seen } = world(on, { healthScript: { codex: OK_CODEX, agy: null } })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    expect(seen.statuses.at(-1)).toBe('codex ✓ agy ? local –')
  })

  test('a status script that cannot start or prints no JSON leaves every service ?', async ($, on) => {
    const { clock, seen } = world(on, { healthScript: 'throw' })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    expect(seen.statuses.at(-1)).toBe('codex ? agy ? local –')
  })

  test('a status script that exits with an error leaves every service ?', async ($, on) => {
    const { clock, seen } = world(on, { healthScript: { stdout: 'SyntaxError: x', exitCode: 1 } })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    expect(seen.statuses.at(-1)).toBe('codex ? agy ? local –')
  })

  test('a signed-out agy at the start stays pinned after the first prompt', async ($, on) => {
    const { clock, seen } = world(on, { healthScript: { codex: OK_CODEX, agy: SIGNED_OUT_AGY } })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
    expect(seen.statuses.at(-1)).toBe('agy ✗ not signed in — run agy once')
  })

  test('the first prompt of the person clears the start line and the finished row; a task notification does not', async ($, on) => {
    const { clock, seen, state } = world(on, { healthScript: { codex: OK_CODEX, agy: OK_AGY } })
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    await pending
    await clock.settle()
    expect(state.finished).toEqual(['call-1'])
    await $.prompt.submit({ text: '<task-notification>', wait: false, origin: { kind: 'task-notification' } })
    expect(state.finished).toEqual(['call-1'])
    await $.prompt.submit({ text: 'next question', wait: false, origin: { kind: 'composer' } })
    expect(state.finished).toEqual([])
    expect(seen.statuses.at(-1)).toBe(undefined)
    expect((state.health as Health).showStartLine).toBe(false)
  })

  test('a not-logged-in failure pins codex; a later answer clears it', async ($, on) => {
    const { clock, seen } = world(on)
    let answer = fixtures.CODEX_NOT_SIGNED_IN
    answerConsult(on, clock, () => answer, { afterMs: 1000 })
    let pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    await pending
    await clock.settle()
    expect(seen.statuses.at(-1)).toBe('codex ✗ not signed in — run codex login')
    answer = fixtures.CODEX_ANSWER
    pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-2', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    await pending
    await clock.settle()
    expect(seen.statuses.at(-1)).toBe(undefined)
  })
})
