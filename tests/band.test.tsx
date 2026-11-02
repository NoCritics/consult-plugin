import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { CallRecord } from '../types'
import * as fixtures from './fixtures/results'
import { CONSULT, DELEGATE_DATA, PLUGIN, answerConsult, beatInstance, delegateRow, setDelegateIndex, world } from './world'
import type { World, WorldOptions } from './world'

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

const START = { cwd: 'C:/proj', surface: 'terminal', isInteractive: true } as const
const TASK = 'd3f9a1'

// A session of C:/proj whose index holds `rows`; the default row is a running
// codex task this session owns, started at the clock's start.
async function withTasks($: Engine, on: On, rows: Record<string, unknown>[], options: WorldOptions = {}, before?: (w: World) => void): Promise<World> {
  const w = world(on, options)
  engineBand(on)
  before?.(w)
  beatInstance(w, 'inst-1', w.clock.now())
  setDelegateIndex(w, rows)
  await $.session.start(START)
  await w.clock.settle()
  return w
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
    expect(await ui.find({ text: /ask · codex · gpt-6-astra · high/ })).toBeDefined()
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

  test('a running row fits a band narrowed by the docked pane', { timeoutMs: 20000 }, async ($, on) => {
    const { clock } = world(on)
    engineBand(on)
    answerConsult(on, clock, fixtures.CODEX_ANSWER, { afterMs: 600000 })
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x', model: 'gpt-6-astra', reasoning_effort: 'high' })
    await clock.settle()
    await clock.advance(242000)
    for (const bodyColumns of [80, 64, 52]) {
      const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns } })
      let row: Found | undefined
      for (const box of await ui.findAll({ type: 'Box' })) {
        if (box.props.flexDirection === 'row' && box.text.includes('4:02 / 10:00')) row = box
      }
      // The terminal draws the Cancel label as `[ Cancel ]`, and the frame takes four columns.
      const drawnWidth = (row?.text.length ?? 0) + '[  ]'.length + 4
      expect(drawnWidth <= bodyColumns).toBe(true)
      expect(row?.text).toContain('codex')
      await ui.unmount()
    }
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
    const row = await ui.find({ text: /✓ ask · codex/ })
    expect(row?.text).toContain('42 s')
    expect(row?.text).toContain('Use a tagged')
    expect(await ui.find({ key: 'answers' })).toBeDefined()
    const frames = await roundBoxes(ui)
    expect(frames.length).toBe(1)
    expect(frames[0]?.text).toContain('✓ ask · codex')
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

  test('a running delegated task draws its row, its clock against its limit and Cancel', async ($, on) => {
    const w = await withTasks($, on, [delegateRow({ model: 'gpt-6-astra', time_limit_ms: 180 * 60000 })], { delegate: args => (args[0] === 'show' ? { error: 'no show in this test' } : { cancelling: true }) })
    await w.clock.advance(12 * 60000)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /delegate · codex · gpt-6-astra/ })).toBeDefined()
    expect(await ui.find({ text: /12m \/ 3h00m/ })).toBeDefined()
    expect(await ui.find({ key: 'answers' })).toBeUndefined()
    await ui.press({ key: 'tasks' })
    expect(w.seen.opened).toEqual(['consult'])
    expect(w.state.pane).toEqual(expect.objectContaining({ tab: 'delegated' }))
    await ui.press({ key: `cancel-task:${TASK}` })
    await w.clock.settle()
    const commands: string[] = []
    for (const run of w.seen.delegateRuns) commands.push(run.argv.slice(3).join(' '))
    expect(commands).toContain(`cancel ${TASK}`)
    await ui.unmount()
  })

  test('a row an older server rewrote without its limit keeps the limit and the bar the band knew', async ($, on) => {
    const w = await withTasks($, on, [delegateRow({ time_limit_ms: 180 * 60000 })])
    await w.clock.advance(5000)
    setDelegateIndex(w, [delegateRow()])
    await w.clock.advance(5 * 60000)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /5m05s \/ 3h00m/ })).toBeDefined()
    // The bar is drawn again, not only the clock.
    expect((await roundBoxes(ui))[0]?.text).toContain('░')
    await ui.unmount()
  })

  test('a row first seen without its limit takes it from the task state file', async ($, on) => {
    const w = await withTasks($, on, [delegateRow()], {}, world => {
      world.files[`${DELEGATE_DATA}/tasks/${TASK}/state.json`] = JSON.stringify({ id: TASK, time_limit_ms: 180 * 60000 })
    })
    await w.clock.advance(5000)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /5s \/ 3h00m/ })).toBeDefined()
    await ui.unmount()
  })

  test('a task with its fence lifted says so in its row', async ($, on) => {
    await withTasks($, on, [delegateRow({ fence: 'full', time_limit_ms: 180 * 60000 })])
    for (const columns of [120, 52]) {
      const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: columns } })
      if (columns === 120) expect(await ui.find({ text: /unfenced · delegate · codex/ })).toBeDefined()
      let row: Found | undefined
      for (const box of await ui.findAll({ type: 'Box' })) {
        if (box.props.flexDirection === 'row' && box.text.includes('unfenced')) row = box
      }
      expect(row?.text).toContain('unfenced')
      expect((row?.text.length ?? 0) + '[  ]'.length + 4 <= columns).toBe(true)
      await ui.unmount()
    }
  })

  test('an agy task with its fence lifted says unfenced', async ($, on) => {
    await withTasks($, on, [delegateRow({ worker: 'agy', fence: 'none' })])
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /unfenced · delegate · agy/ })).toBeDefined()
    await ui.unmount()
  })

  test('a task without a fence field shows no marker', async ($, on) => {
    await withTasks($, on, [delegateRow()])
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /delegate · codex · default/ })).toBeDefined()
    expect(await ui.find({ text: /unfenced/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a row whose fence is not a known value shows no marker', async ($, on) => {
    await withTasks($, on, [delegateRow({ fence: 'wide-open' })])
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /delegate · codex · default/ })).toBeDefined()
    expect(await ui.find({ text: /unfenced|wide-open/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a row first seen without its fence takes it from the task state file', async ($, on) => {
    await withTasks($, on, [delegateRow()], {}, world => {
      world.files[`${DELEGATE_DATA}/tasks/${TASK}/state.json`] = JSON.stringify({ id: TASK, fence: 'full' })
    })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /unfenced/ })).toBeDefined()
    await ui.unmount()
  })

  test('a queued task says so, and a row with no limit shows its clock alone, with no bar', async ($, on) => {
    const w = await withTasks($, on, [delegateRow({ state: 'queued', started_at: null })])
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /delegate · codex · default/ })).toBeDefined()
    expect(await ui.find({ text: /queued/ })).toBeDefined()
    setDelegateIndex(w, [delegateRow({ started_at: w.clock.now() })])
    await w.clock.advance(5000)
    expect(await ui.find({ text: /^ +5s  $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^[█▌░]+$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('an ask and a task share one frame, the ask first', async ($, on) => {
    const { clock } = await withTasks($, on, [delegateRow()], {}, w => answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 60000 }))
    const pending = $.tool.call({ tool: `${CONSULT}ask_agy`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    const frames = await roundBoxes(ui)
    expect(frames.length).toBe(1)
    const text = frames[0]?.text ?? ''
    expect(text.indexOf('ask · agy') >= 0 && text.indexOf('ask · agy') < text.indexOf('delegate · codex')).toBe(true)
    expect(text.split('consult').length - 1).toBe(1)
    await ui.unmount()
    await clock.advance(60000)
    await pending
    await clock.settle()
  })

  test('a task that ends joins the finished row until the person types', async ($, on) => {
    const w = await withTasks($, on, [delegateRow()])
    await w.clock.advance(5000)
    setDelegateIndex(w, [delegateRow({ state: 'done', ended_at: 1_000_000 + 42 * 60000 })])
    await w.clock.advance(5000)
    await w.clock.settle()
    const ui = await $.ui.mount(BAND)
    const row = await ui.find({ text: /✓ delegate · codex · default/ })
    expect(row?.text).toContain('finished')
    expect(await ui.find({ key: `cancel-task:${TASK}` })).toBeUndefined()
    // The wake notice is the mod's own prompt: the row stays.
    expect(w.seen.submitted.length).toBe(1)
    expect(await ui.find({ text: /✓ delegate/ })).toBeDefined()
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    await w.clock.settle()
    expect(await ui.find({ text: /engine band/ })).toBeDefined()
    await w.clock.advance(10000)
    expect(await ui.find({ text: /engine band/ })).toBeDefined()
    await ui.unmount()
  })

  test('a task that ends while another runs stays in its place as its result line', async ($, on) => {
    const w = await withTasks($, on, [delegateRow({ id: 'aaaaaa', worker: 'agy' }), delegateRow({ id: 'bbbbbb' })])
    await w.clock.advance(5000)
    setDelegateIndex(w, [delegateRow({ id: 'aaaaaa', worker: 'agy', state: 'done', ended_at: 1_000_000 + 3 * 60000 }), delegateRow({ id: 'bbbbbb' })])
    await w.clock.advance(5000)
    await w.clock.settle()
    for (const columns of [120, 52]) {
      const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: columns } })
      const frames = await roundBoxes(ui)
      expect(frames.length).toBe(1)
      const text = frames[0]?.text ?? ''
      expect(text).toContain('✓ delegate · agy')
      // At 52 columns the running row's label is cut: its Cancel marks it.
      expect(text.indexOf('✓ delegate · agy')).toBeLessThan(text.indexOf('Cancel'))
      expect(await ui.find({ key: 'cancel-task:aaaaaa' })).toBeUndefined()
      expect(await ui.find({ key: 'cancel-task:bbbbbb' })).toBeDefined()
      for (const box of await ui.findAll({ type: 'Box' })) {
        if (box.props.flexDirection === 'row' && box.text.includes('delegate') && !box.text.includes('Tasks')) {
          // A Button's text is its label alone: its brackets are added back.
          const brackets = box.text.includes('Cancel') ? '[  ]'.length : 0
          expect(box.text.length + brackets + 4 <= columns).toBe(true)
        }
      }
      await ui.unmount()
    }
    // The person's prompt takes the ended row away; the running one stays.
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    await w.clock.settle()
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ text: /✓ delegate/ })).toBeUndefined()
    expect(await ui.find({ key: 'cancel-task:bbbbbb' })).toBeDefined()
    await ui.unmount()
  })

  test('an ask that ends while a task runs shows its result line above the task', async ($, on) => {
    const { clock } = await withTasks($, on, [delegateRow()], {}, w => answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 }))
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await clock.advance(1000)
    await pending
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    const text = (await roundBoxes(ui))[0]?.text ?? ''
    expect(text).toContain('✓ ask · codex')
    expect(text.indexOf('✓ ask · codex')).toBeLessThan(text.indexOf('delegate · codex'))
    expect(await ui.find({ key: 'answers' })).toBeDefined()
    await ui.unmount()
  })

  test('past three ended rows, the older ones fold into one line above them', async ($, on) => {
    const { clock } = await withTasks($, on, [delegateRow()], {}, w => answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 }))
    for (let index = 1; index <= 5; index++) {
      const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: `call-${index}`, prompt: 'x' })
      await clock.advance(1000)
      await pending
      await clock.settle()
    }
    const ui = await $.ui.mount(BAND)
    const text = (await roundBoxes(ui))[0]?.text ?? ''
    expect(text).toContain('✓ 2 answers')
    expect(text.split('✓ ask · codex').length - 1).toBe(3)
    expect(text.indexOf('✓ 2 answers')).toBeLessThan(text.indexOf('✓ ask · codex'))
    expect(text.split('consult').length - 1).toBe(1)
    expect(await ui.find({ key: `cancel-task:${TASK}` })).toBeDefined()
    await ui.unmount()
  })

  test('a task that had ended before the band saw it, and a failed one, are drawn as they should be', async ($, on) => {
    const w = await withTasks($, on, [delegateRow({ state: 'done', ended_at: 1_000_000, reported_at: 1_000_000 }), delegateRow({ id: 'aaaaaa' })])
    await w.clock.advance(5000)
    setDelegateIndex(w, [delegateRow({ state: 'done', ended_at: 1_000_000, reported_at: 1_000_000 }), delegateRow({ id: 'aaaaaa', state: 'failed', ended_at: w.clock.now() })])
    await w.clock.advance(5000)
    await w.clock.settle()
    const ui = await $.ui.mount(BAND)
    const row = await ui.find({ text: /✗ delegate · codex/ })
    expect(row?.text).toContain('failed')
    await ui.unmount()
  })

  test('a Cancel the delegate script refuses says so in a toast', async ($, on) => {
    const w = await withTasks($, on, [delegateRow()], { delegate: () => ({ error: 'task d3f9a1 has already ended' }) })
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: `cancel-task:${TASK}` })
    await w.clock.settle()
    expect(w.seen.toasts).toEqual([`consult: could not cancel task ${TASK} (task d3f9a1 has already ended)`])
    await ui.unmount()
  })

  test('under a limit of ten hours or more the clock shows the time alone, and the row still fits', async ($, on) => {
    const now = 100_000_000
    await withTasks($, on, [delegateRow({ time_limit_ms: 24 * 60 * 60000, started_at: now - (10 * 60 + 5) * 60000 })], { now })
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 52 } })
    let row: Found | undefined
    for (const box of await ui.findAll({ type: 'Box' })) {
      if (box.props.flexDirection === 'row' && box.text.includes('delegate')) row = box
    }
    expect(row?.text).toContain('10h05m')
    expect(row?.text).not.toContain('24h00m')
    expect((row?.text.length ?? 0) + '[  ]'.length + 4 <= 52).toBe(true)
    await ui.unmount()
  })

  test('a row with no bar keeps its clock and Cancel in line with the rows above', async ($, on) => {
    const w = await withTasks($, on, [delegateRow({ id: 'aaaaaa', time_limit_ms: 180 * 60000 }), delegateRow({ id: 'bbbbbb' })])
    await w.clock.advance(5000)
    const ui = await $.ui.mount(BAND)
    const rows: Found[] = []
    for (const box of await ui.findAll({ type: 'Box' })) {
      if (box.props.flexDirection === 'row' && box.text.includes('delegate')) rows.push(box)
    }
    expect(rows.length).toBe(2)
    expect(rows[0]?.text.indexOf('Cancel')).toBe(rows[1]?.text.indexOf('Cancel'))
    await ui.unmount()
  })

  test('a task that ended in the queue has no run time, and a model name is drawn on one line', async ($, on) => {
    const w = await withTasks($, on, [delegateRow({ state: 'queued', started_at: null, model: 'qwen\n3.5\u001b[2J' })])
    await w.clock.advance(5000)
    setDelegateIndex(w, [delegateRow({ state: 'cancelled', started_at: null, ended_at: w.clock.now() + 20 * 60000, model: 'qwen\n3.5\u001b[2J' })])
    await w.clock.advance(5000)
    const ui = await $.ui.mount(BAND)
    const row = await ui.find({ text: /✗ delegate/ })
    expect(row?.text).toContain('delegate · codex · qwen 3.5 [2J — cancelled')
    await ui.unmount()
  })

  test('several finished items fit a narrow band', async ($, on) => {
    const w = await withTasks($, on, [delegateRow({ id: 'aaaaaa' }), delegateRow({ id: 'bbbbbb' })], {}, world => answerConsult(on, world.clock, fixtures.CODEX_NOT_SIGNED_IN, { afterMs: 1000 }))
    const pending = $.tool.call({ tool: `${CONSULT}ask_codex`, tool_use_id: 'call-1', prompt: 'x' })
    await w.clock.advance(1000)
    await pending
    setDelegateIndex(w, [delegateRow({ id: 'aaaaaa', state: 'done', ended_at: w.clock.now() }), delegateRow({ id: 'bbbbbb', state: 'held', ended_at: w.clock.now() })])
    await w.clock.advance(5000)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 40 } })
    const frames = await roundBoxes(ui)
    expect(frames[0]?.text).toContain('✓ 2 tasks')
    expect((frames[0]?.text.length ?? 0) + '[  ]'.length + 4 <= 40).toBe(true)
    await ui.unmount()
  })
})
