import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { CallRecord } from '../types'
import * as fixtures from './fixtures/results'
import { CONSULT, PLUGIN, answerConsult, world } from './world'

const DENY = 'Cancelled by the user from the consult band.'

type Found = { type: string; props: Record<string, unknown>; text: string }

// The rounded boxes a drawing holds: the band's frame, the pane's groups.
async function roundBoxes(ui: { findAll: (query: { type: string }) => Promise<Found[]> }): Promise<Found[]> {
  const boxes: Found[] = []
  for (const box of await ui.findAll({ type: 'Box' })) {
    if (box.props.borderStyle === 'round') boxes.push(box)
  }
  return boxes
}

const BAND = {
  plugin: PLUGIN,
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 19, bodyColumns: 80, scroll: { offset: 0, bodyRows: 18 }, view: {} },
} as const

// The engine's own band, drawn when the mod passes: the test stands beneath it.
function engineBand(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['engine band'] }) as never)
}

describe('band', () => {
  test('nothing running and nothing finished draws the engine band', async ($, on) => {
    world(on)
    engineBand(on)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /engine band/ })).toBeDefined()
    expect(await ui.find({ key: 'answers' })).toBeUndefined()
    await ui.unmount()
  })

  test('a running codex call draws its row, its clock and its buttons', { timeoutMs: 20000 }, async ($, on) => {
    const { clock } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 600000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x', model: 'gpt-6-astra', reasoning_effort: 'high' })
    await clock.settle()
    await clock.advance(242000)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /codex · gpt-6-astra · high/ })).toBeDefined()
    expect(await ui.find({ text: /4:02 \/ 10:00/ })).toBeDefined()
    expect(await ui.find({ key: 'cancel:call-1' })).toBeDefined()
    expect(await ui.find({ key: 'answers' })).toBeDefined()
    // The rows sit in one rounded grey box, as compact-view's band does.
    const frames = await roundBoxes(ui)
    expect(frames.length).toBe(1)
    expect(frames[0]?.props.borderColor).toBe('inactive')
    expect(frames[0]?.text).toContain('4:02 / 10:00')
    await clock.advance(1000)
    expect(await ui.find({ text: /4:03 \/ 10:00/ })).toBeDefined()
    await ui.unmount()
    await clock.advance(400000)
    await pending
    await clock.settle()
  })

  test('after the call moved to the background, its row stays and Cancel stops the task', async ($, on) => {
    const { clock, seen, state } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.backgroundNotice('task1'), { afterMs: 120000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(120000)
    await pending
    await clock.settle()
    await clock.advance(60000)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /3:00 \/ 10:00/ })).toBeDefined()
    await ui.press({ key: 'cancel:call-1' })
    await clock.settle()
    expect(seen.taskStops).toEqual(['task1'])
    expect((state.calls as CallRecord[])[0]?.status).toBe('cancelled')
    expect(seen.toasts).toEqual(['consult: codex cancelled'])
    await ui.unmount()
  })

  test('an answer that arrives while TaskStop waits on a prompt is kept', async ($, on) => {
    const { clock, seen, state, store } = world(on, { taskStop: 'slow' })
    engineBand(on)
    answerConsult(on, clock, fixtures.backgroundNotice('task1'), { afterMs: 120000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(120000)
    await pending
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    const pressing = ui.press({ key: 'cancel:call-1' })
    await clock.settle()
    await $.prompt.submit({
      text: fixtures.taskNotification('task1', 'completed', fixtures.CODEX_ANSWER.text ?? ''),
      wait: false,
      origin: { kind: 'task-notification' },
    })
    await clock.settle()
    await clock.advance(10000)
    await pressing
    await clock.settle()
    const call = (state.calls as CallRecord[])[0]
    expect(call?.status).toBe('answered')
    expect(call?.answer).toContain('Use a tagged union')
    expect((store.history as { answer: string }[])[0]?.answer).toContain('Use a tagged union')
    expect(seen.toasts.length).toBe(1)
    await ui.unmount()
  })

  test('a second Cancel while TaskStop waits sends no second TaskStop', async ($, on) => {
    const { clock, seen } = world(on, { taskStop: 'slow' })
    engineBand(on)
    answerConsult(on, clock, fixtures.backgroundNotice('task1'), { afterMs: 120000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(120000)
    await pending
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    const first = ui.press({ key: 'cancel:call-1' })
    await clock.settle()
    const second = ui.press({ key: 'cancel:call-1' })
    await clock.settle()
    await clock.advance(10000)
    await Promise.all([first, second])
    await clock.settle()
    expect(seen.taskStops).toEqual(['task1'])
    expect(seen.toasts).toEqual(['consult: codex cancelled'])
    await ui.unmount()
  })

  test('when TaskStop is refused, Cancel says to ask Claude and the call keeps running', async ($, on) => {
    const { clock, seen, state } = world(on, { taskStop: 'refused' })
    engineBand(on)
    answerConsult(on, clock, fixtures.backgroundNotice('task1'), { afterMs: 120000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(120000)
    await pending
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'cancel:call-1' })
    await clock.settle()
    expect((state.calls as CallRecord[])[0]?.status).toBe('running')
    expect(seen.toasts).toEqual(['consult: could not stop codex here: ask Claude to stop task task1'])
    await ui.unmount()
  })

  test('pressing Cancel denies the call and records it cancelled', async ($, on) => {
    const { clock, seen, state } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 60000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(5000)
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'cancel:call-1' })
    const ran = await pending
    await clock.settle()
    const deniedText = 'deny' in ran && ran.deny !== undefined ? ran.deny : String((ran as { text?: string }).text)
    expect(deniedText).toContain(DENY)
    expect((state.calls as CallRecord[])[0]?.status).toBe('cancelled')
    expect(seen.toasts).toEqual(['consult: codex cancelled'])
    await ui.unmount()
  })

  test('once the call finished its Cancel is gone and the answer stands', async ($, on) => {
    const { clock, state } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'cancel:call-1' })).toBeDefined()
    await clock.advance(1000)
    const ran = await pending
    await clock.settle()
    expect(await ui.find({ key: 'cancel:call-1' })).toBeUndefined()
    expect(ran).toEqual(fixtures.CODEX_ANSWER)
    expect((state.calls as CallRecord[]).length).toBe(1)
    expect((state.calls as CallRecord[])[0]?.status).toBe('answered')
    await ui.unmount()
  })

  test('a call at 80 % of its limit draws its bar in the warning colour', { timeoutMs: 20000 }, async ($, on) => {
    const { clock } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.AGY_ANSWER_WITH_DENIED, { afterMs: 170000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_agy`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(144000)
    const ui = await $.ui.mount(BAND)
    const bar = await ui.find({ type: 'Text', text: /^[█▌░]+$/ })
    expect(bar?.props.color).toBe('warning')
    await clock.advance(20000)
    expect((await ui.find({ type: 'Text', text: /^[█▌░]+$/ }))?.props.color).toBe('error')
    await ui.unmount()
    await clock.advance(10000)
    await pending
    await clock.settle()
  })

  test('one finished call draws the slim row', async ($, on) => {
    const { clock } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 42000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(42000)
    await pending
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    const row = await ui.find({ text: /✓ codex/ })
    expect(row?.text).toContain('42 s')
    expect(row?.text).toContain('Use a tagged union')
    expect(await ui.find({ key: 'answers' })).toBeDefined()
    const frames = await roundBoxes(ui)
    expect(frames.length).toBe(1)
    expect(frames[0]?.text).toContain('✓ codex')
    expect(await ui.find({ key: 'cancel:call-1' })).toBeUndefined()
    await ui.unmount()
  })

  test('several finished calls are counted', async ($, on) => {
    const { clock } = world(on)
    engineBand(on)
    answerConsult(on, clock, tool => (tool.endsWith('ask_gemini') ? fixtures.CODEX_NOT_SIGNED_IN : fixtures.CODEX_ANSWER), { afterMs: 1000 })
    const pending = [
      $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' }),
      $.tool.call({ tool: `${CONSULT}ask_agy`, tool_use_id: 'call-2', prompt: 'x' }),
      $.tool.call({ tool: `${CONSULT}ask_local`, tool_use_id: 'call-3', prompt: 'x' }),
      $.tool.call({ tool: `${CONSULT}ask_gemini`, tool_use_id: 'call-4', prompt: 'x' }),
    ]
    await clock.settle()
    await clock.advance(1000)
    await Promise.all(pending)
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /✓ 3 answers · 1 error/ })).toBeDefined()
    await ui.unmount()
  })

  test('a survey holds the band', async ($, on) => {
    const { clock } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ text: /engine band/ })).toBeDefined()
    await ui.unmount()
    await clock.advance(1000)
    await pending
    await clock.settle()
  })

  test('Answers opens the consult pane', async ($, on) => {
    const { clock, seen } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    await clock.advance(1000)
    await pending
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'answers' })
    expect(seen.opened).toEqual(['consult'])
    await ui.unmount()
  })
})
