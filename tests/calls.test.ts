import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { CallRecord, HistoryEntry } from '../types'
import * as fixtures from './fixtures/results'
import { CONSULT, answerConsult, world } from './world'
import { formatClock, formatDuration, progressBar } from '../hooks/mod/format'

describe('calls', () => {
  test('an answered ask_codex leaves a record, the finished row, history and a toast', async ($, on) => {
    const { clock, seen, state, store } = world(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 42000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'What is X?', reasoning_effort: 'high' })
    await clock.settle()
    const running = state.calls as CallRecord[]
    expect(running.length).toBe(1)
    expect(running[0]?.status).toBe('running')
    expect(running[0]?.limitMs).toBe(600000)
    expect(running[0]?.effort).toBe('high')

    await clock.advance(42000)
    const ran = await pending
    await clock.settle()
    expect(ran).toEqual(fixtures.CODEX_ANSWER)

    const calls = state.calls as CallRecord[]
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual(expect.objectContaining({ id: 'call-1', status: 'answered', model: 'gpt-6-astra', provider: 'codex' }))
    expect(calls[0]?.summary).toBe('Use a tagged union instead of the boolean flags; it makes the states explicit.')
    expect(state.finished).toEqual(['call-1'])
    const history = store.history as HistoryEntry[]
    expect(history.length).toBe(1)
    expect(history[0]?.durationMs).toBe(42000)
    expect(seen.toasts).toEqual(['consult: ✓ codex · gpt-6-astra · 42 s'])
    expect(seen.pushes).toEqual([])
  })

  test('a call of 130 s pushes with the defaults', async ($, on) => {
    const { clock, seen, state } = world(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 130000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(130000)
    await pending
    await clock.settle()
    expect(seen.pushes).toEqual(['consult: codex finished after 2:10'])
  })

  test('notify_after_s: 0 turns the push off', async ($, on) => {
    const { clock, seen, state } = world(on, { files: { 'C:/proj/.claude/consult.local.md': '---\nnotify_after_s: 0\n---\n' } })
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 130000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(130000)
    await pending
    await clock.settle()
    expect(seen.pushes).toEqual([])
  })

  test('INCOMPLETE is recorded as a timeout and passed on unchanged', async ($, on) => {
    const { clock, seen, state } = world(on)
    answerConsult(on, clock, fixtures.CODEX_INCOMPLETE, { afterMs: 30000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x', timeout_s: 30 })
    await clock.settle()
    await clock.advance(30000)
    const ran = await pending
    await clock.settle()
    expect(ran).toEqual(expect.objectContaining({ isError: true, text: fixtures.CODEX_INCOMPLETE.text }))
    const calls = state.calls as CallRecord[]
    expect(calls[0]?.status).toBe('timeout')
    expect(seen.toasts).toEqual(['consult: ✗ codex timed out after 0:30'])
  })

  test('two calls finishing on the same advance both finish', async ($, on) => {
    const { clock, seen, state, store } = world(on)
    answerConsult(on, clock, tool => (tool.endsWith('ask_agy') ? fixtures.AGY_ANSWER_WITH_DENIED : fixtures.CODEX_ANSWER), { afterMs: 20000 })
    const first = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    const second = $.tool.call({ tool: `${CONSULT}ask_agy`, tool_use_id: 'call-2', prompt: 'x' })
    await clock.settle()
    await clock.advance(20000)
    await Promise.all([first, second])
    await clock.settle()
    const calls = state.calls as CallRecord[]
    expect(calls.map(call => call.status)).toEqual(['answered', 'answered'])
    expect((state.finished as string[]).slice().sort()).toEqual(['call-1', 'call-2'])
    const history = store.history as HistoryEntry[]
    expect(history.length).toBe(2)
    expect(seen.toasts.length).toBe(2)
  })

  test('untracked tools pass through with no record', async ($, on) => {
    const { clock, state } = world(on)
    answerConsult(on, clock, fixtures.PLAIN_TEXT)
    on('tool.call', { tool: 'mcp__gh__issue' }, () => ({ result: 'issue #1' }))
    const status = await $.tool.call({ tool: `${CONSULT}agy_status`, tool_use_id: 'call-1' })
    expect(status).toEqual(fixtures.PLAIN_TEXT)
    const issue = await $.tool.call({ tool: 'mcp__gh__issue', tool_use_id: 'call-2' })
    expect(issue).toEqual(expect.objectContaining({ result: 'issue #1' }))
    expect(state.calls).toBeUndefined()
  })

  test('timeout_s sets the record limit', async ($, on) => {
    const { clock, state } = world(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x', timeout_s: 1200 })
    await clock.settle()
    const calls = state.calls as CallRecord[]
    expect(calls[0]?.limitMs).toBe(1200000)
    await clock.advance(1000)
    await pending
    await clock.settle()
  })

  test('a fault in the mod still passes the call through', async ($, on) => {
    const { clock, state } = world(on, { defaultsThrow: true, envThrows: true })
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    expect(await pending).toEqual(fixtures.CODEX_ANSWER)
  })

  test('summary_model: haiku rewrites the summary after the call returned', async ($, on) => {
    const { clock, seen, state, store } = world(on, { files: { 'C:/proj/.claude/consult.local.md': '---\nsummary_model: haiku\n---\n' } })
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    await pending
    await clock.settle()
    expect(seen.modelPrompts.length).toBe(1)
    expect((state.calls as CallRecord[])[0]?.summary).toBe('A haiku summary.')
    expect((store.history as HistoryEntry[])[0]?.summary).toBe('A haiku summary.')
  })

  test('two calls failing at once both reach history', async ($, on) => {
    const { clock, store } = world(on, { storeGetDelayMs: 10 })
    answerConsult(on, clock, fixtures.AGY_BINARY_MISSING, { afterMs: 1000 })
    const first = $.tool.call({ tool: `${CONSULT}ask_agy`, tool_use_id: 'call-1', prompt: 'x' })
    const second = $.tool.call({ tool: `${CONSULT}ask_gemini`, tool_use_id: 'call-2', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    await Promise.all([first, second])
    await clock.settle()
    for (let step = 0; step < 6; step++) await clock.advance(10)
    const ids = (store.history as HistoryEntry[]).map(entry => entry.id).sort()
    expect(ids).toEqual(['call-1', 'call-2'])
  })

  test('Claude gets the answer without waiting for the history write', async ($, on) => {
    const { clock, state } = world(on, { storeGetDelayMs: 60000 })
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    let isAnswered = false
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' }).then(ran => {
      isAnswered = true
      return ran
    })
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()
    expect(isAnswered).toBe(true)
    expect((state.calls as CallRecord[])[0]?.status).toBe('answered')
    await clock.advance(60000)
    await pending
    await clock.settle()
  })

  test('a call whose server throws ends as an error, not running', async ($, on) => {
    const { clock, state } = world(on)
    on('tool.call', { tool: /^mcp__plugin_consult_consult__/ }, async () => {
      await clock.sleep(1000)
      throw new Error('server crashed')
    })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' }).catch(() => 'rejected')
    await clock.settle()
    await clock.advance(1000)
    await pending
    await clock.settle()
    expect((state.calls as CallRecord[])[0]?.status).toBe('error')
    expect(state.finished).toEqual(['call-1'])
  })

  test('a call records the time of the prompt it answers; a task notification is not a new prompt', async ($, on) => {
    const { clock, state } = world(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    let pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-0', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    await pending
    await $.prompt.submit({ text: 'ask codex', wait: false, origin: { kind: 'composer' } })
    const askedAt = await clock.now()
    await clock.advance(5000)
    await $.prompt.submit({ text: '<task-notification>', wait: false, origin: { kind: 'task-notification' } })
    pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    await pending
    await clock.settle()
    const calls = state.calls as CallRecord[]
    expect(calls[0]?.turnStartedAt).toBe(null)
    expect(calls[1]?.turnStartedAt).toBe(askedAt)
  })

  test('tick counts seconds while a call runs and stops after', async ($, on) => {
    const { clock, state } = world(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 3500 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    const before = (state.tick as number | undefined) ?? 0
    await clock.advance(3000)
    expect((state.tick as number) - before).toBe(3)
    await clock.advance(500)
    await pending
    await clock.settle()
    const ended = state.tick as number
    await clock.advance(5000)
    expect(state.tick).toBe(ended)
  })
})

// Claude Code moves an MCP call still running at 120 s to the background:
// next(e) resolves to a notice, and the real result comes later as a task
// notification prompt.
describe('background', () => {
  const NOTIFIED = { wait: false, origin: { kind: 'task-notification' } } as const
  const ANSWER_TEXT = fixtures.CODEX_ANSWER.text ?? ''

  async function backgrounded($: Engine, on: On, taskId = 'task1') {
    const w = world(on)
    answerConsult(on, w.clock, fixtures.backgroundNotice(taskId), { afterMs: 120000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'a long essay' })
    await w.clock.settle()
    await w.clock.advance(120000)
    const ran = await pending
    await w.clock.settle()
    return { ...w, ran }
  }

  test('a call moved to the background stays running and Claude gets the notice unchanged', async ($, on) => {
    const { ran, seen, state, store } = await backgrounded($, on)
    expect(ran).toEqual(fixtures.backgroundNotice('task1'))
    const calls = state.calls as CallRecord[]
    expect(calls[0]?.status).toBe('running')
    expect(calls[0]?.taskId).toBe('task1')
    expect(state.finished ?? []).toEqual([])
    expect(seen.toasts).toEqual([])
    expect(store.history).toBeUndefined()
  })

  test('its task notification settles it with the real answer, toast, push and history', async ($, on) => {
    const { clock, seen, state, store } = await backgrounded($, on)
    await clock.advance(46000)
    await $.prompt.submit({ text: fixtures.taskNotification('task1', 'completed', ANSWER_TEXT), ...NOTIFIED })
    await clock.settle()
    const calls = state.calls as CallRecord[]
    expect(calls[0]?.status).toBe('answered')
    expect(calls[0]?.model).toBe('gpt-6-astra')
    expect(calls[0]?.summary).toBe('Use a tagged union instead of the boolean flags; it makes the states explicit.')
    expect(calls[0]?.endedAt).toBe((calls[0]?.startedAt ?? 0) + 166000)
    expect(state.finished).toEqual(['call-1'])
    expect((store.history as HistoryEntry[])[0]?.answer).toContain('Use a tagged union')
    expect(seen.toasts).toEqual(['consult: ✓ codex · gpt-6-astra · 2:46'])
    expect(seen.pushes).toEqual(['consult: codex finished after 2:46'])
  })

  test('a notification flagged meta still settles its call', async ($, on) => {
    const { clock, state } = await backgrounded($, on)
    await $.prompt.submit({ text: fixtures.taskNotification('task1', 'completed', ANSWER_TEXT), ...NOTIFIED, isMeta: true })
    await clock.settle()
    expect((state.calls as CallRecord[])[0]?.status).toBe('answered')
  })

  test('two notifications joined in one prompt settle both calls', async ($, on) => {
    const { clock, state } = world(on)
    answerConsult(on, clock, tool => (tool.endsWith('ask_agy') ? fixtures.backgroundNotice('taskB', 'ask_agy') : fixtures.backgroundNotice('taskA')), { afterMs: 120000 })
    const first = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    const second = $.tool.call({ tool: `${CONSULT}ask_agy`, tool_use_id: 'call-2', prompt: 'x' })
    await clock.settle()
    await clock.advance(120000)
    await Promise.all([first, second])
    await clock.settle()
    const joined = [
      fixtures.taskNotification('taskA', 'completed', ANSWER_TEXT),
      fixtures.taskNotification('taskB', 'completed', fixtures.AGY_ANSWER_WITH_DENIED.text ?? ''),
    ].join('\n')
    await $.prompt.submit({ text: joined, ...NOTIFIED })
    await clock.settle()
    const calls = state.calls as CallRecord[]
    expect(calls.map(call => call.status)).toEqual(['answered', 'answered'])
    expect(calls[0]?.answer).toContain('Use a tagged union')
    expect(calls[0]?.answer).not.toContain('task-notification')
    expect(calls[1]?.answer).toContain('From memory')
  })

  test('a failed task with an INCOMPLETE result is a timeout', async ($, on) => {
    const { clock, state } = await backgrounded($, on)
    await $.prompt.submit({ text: fixtures.taskNotification('task1', 'failed', fixtures.CODEX_INCOMPLETE.text ?? ''), ...NOTIFIED })
    await clock.settle()
    expect((state.calls as CallRecord[])[0]?.status).toBe('timeout')
  })

  test('a killed task is cancelled', async ($, on) => {
    const { clock, state } = await backgrounded($, on)
    await $.prompt.submit({ text: fixtures.taskNotification('task1', 'killed', ''), ...NOTIFIED })
    await clock.settle()
    expect((state.calls as CallRecord[])[0]?.status).toBe('cancelled')
  })

  test("a notification for another task or for no consult task changes nothing", async ($, on) => {
    const { clock, seen, state } = await backgrounded($, on)
    await $.prompt.submit({ text: fixtures.taskNotification('other', 'completed', ANSWER_TEXT), ...NOTIFIED })
    await $.prompt.submit({ text: '<task-notification>\n<task-id>shell7</task-id>\n<status>completed</status>\n</task-notification>', ...NOTIFIED })
    await clock.settle()
    expect((state.calls as CallRecord[])[0]?.status).toBe('running')
    expect(seen.toasts).toEqual([])
  })

  test('a person typing the notification format does not settle a call', async ($, on) => {
    const { clock, state } = await backgrounded($, on)
    await $.prompt.submit({ text: fixtures.taskNotification('task1', 'completed', ANSWER_TEXT), wait: false, origin: { kind: 'composer' } })
    await clock.settle()
    expect((state.calls as CallRecord[])[0]?.status).toBe('running')
  })

  test('with no notification, it ends as a timeout a minute past its limit', async ($, on) => {
    const { clock, state } = await backgrounded($, on)
    await clock.advance(600000 - 120000)
    expect((state.calls as CallRecord[])[0]?.status).toBe('running')
    await clock.advance(60000)
    await clock.settle()
    expect((state.calls as CallRecord[])[0]?.status).toBe('timeout')
  })

  test('two backgrounded calls each settle from their own notification', async ($, on) => {
    const { clock, state } = world(on)
    answerConsult(on, clock, tool => (tool.endsWith('ask_agy') ? fixtures.backgroundNotice('taskB', 'ask_agy') : fixtures.backgroundNotice('taskA')), { afterMs: 120000 })
    const first = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    const second = $.tool.call({ tool: `${CONSULT}ask_agy`, tool_use_id: 'call-2', prompt: 'x' })
    await clock.settle()
    await clock.advance(120000)
    await Promise.all([first, second])
    await clock.settle()
    await $.prompt.submit({ text: fixtures.taskNotification('taskB', 'completed', fixtures.AGY_ANSWER_WITH_DENIED.text ?? ''), ...NOTIFIED })
    await clock.settle()
    let calls = state.calls as CallRecord[]
    expect(calls.map(call => call.status)).toEqual(['running', 'answered'])
    await $.prompt.submit({ text: fixtures.taskNotification('taskA', 'completed', ANSWER_TEXT), ...NOTIFIED })
    await clock.settle()
    calls = state.calls as CallRecord[]
    expect(calls.map(call => call.status)).toEqual(['answered', 'answered'])
  })
})

describe('format', () => {
  test('durations, clocks and bars', () => {
    expect(formatDuration(42000)).toBe('42 s')
    expect(formatDuration(242000)).toBe('4:02')
    expect(formatClock(30000)).toBe('0:30')
    expect(formatClock(600000)).toBe('10:00')
    expect(progressBar(0.5, 4)).toBe('██░░')
    expect(progressBar(2, 4)).toBe('████')
    expect(progressBar(-1, 4)).toBe('░░░░')
    expect(progressBar(0.75, 2)).toBe('█▌')
  })
})
