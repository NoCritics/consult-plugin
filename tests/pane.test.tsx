import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { HistoryEntry } from '../types'
import * as fixtures from './fixtures/results'
import { CONSULT, PLUGIN, answerConsult, world } from './world'
import type { World } from './world'

const PANE = {
  plugin: PLUGIN,
  surface: 'terminal',
  component: 'Pane',
  requestId: 'consult',
  props: { title: 'consult', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const COMMAND = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true } }

function earlier(n: number): HistoryEntry {
  return {
    id: `old-${n}`,
    sessionId: 'session-0',
    tool: 'ask_agy',
    provider: 'agy',
    members: [],
    model: 'gemini-3.5-pro',
    effort: null,
    prompt: `old prompt ${n}`,
    startedAt: 500_000 - n * 1000,
    status: 'answered',
    endedAt: 500_000 - n * 1000 + 5000,
    summary: `old summary ${n}`,
    answer: `old answer ${n}`,
    answerTruncated: false,
    images: [],
    council: null,
    turnStartedAt: null,
    taskId: null,
    durationMs: 5000,
  }
}

async function oneCall($: Engine, w: World, tool: string, id: string) {
  const pending = $.tool.call({ tool: `${CONSULT}${tool}`, tool_use_id: id, prompt: `prompt of ${id}` })
  await w.clock.settle()
  await w.clock.advance(1000)
  return pending
}

async function entryKeys(ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }, prefix: string) {
  const keys: string[] = []
  for (const button of await ui.findAll({ type: 'Button' })) {
    if (button.key !== undefined && button.key.startsWith(prefix)) keys.push(button.key)
  }
  return keys
}

type Found = { type: string; props: Record<string, unknown>; text: string }

// The pane's groups: one rounded box per question.
async function groupBoxes(ui: { findAll: (query: { type: string }) => Promise<Found[]> }): Promise<Found[]> {
  const boxes: Found[] = []
  for (const box of await ui.findAll({ type: 'Box' })) {
    if (box.props.borderStyle === 'round') boxes.push(box)
  }
  return boxes
}

const PERSON = { wait: false, origin: { kind: 'composer' } } as const

// The rules that part the answers inside a box: a Text of ─ alone.
async function rules(ui: { findAll: (query: { type: string }) => Promise<Found[]> }): Promise<Found[]> {
  const found: Found[] = []
  for (const text of await ui.findAll({ type: 'Text' })) {
    if (/^─+$/.test(text.text)) found.push(text)
  }
  return found
}

describe('pane', () => {
  test('the calls made for one prompt share a box headed by the question; the next prompt opens another', async ($, on) => {
    const w = world(on)
    answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    await $.prompt.submit({ text: 'ask codex and agy', ...PERSON })
    await oneCall($, w, 'ask_codex', 'call-1')
    await oneCall($, w, 'ask_agy', 'call-2')
    await w.clock.advance(1000)
    await $.prompt.submit({ text: 'now ask codex again', ...PERSON })
    await oneCall($, w, 'ask_codex', 'call-3')
    const ui = await $.ui.mount(PANE)
    const groups = await groupBoxes(ui)
    expect(groups.length).toBe(2)
    expect(groups[0]?.props.borderColor).toBe('inactive')
    // Newest first: the second prompt's one call, then the first prompt's two.
    expect(groups[0]?.text).toContain('prompt of call-3')
    expect(groups[0]?.text).not.toContain('agy')
    expect(groups[1]?.text).toContain('codex')
    expect(groups[1]?.text).toContain('agy')
    expect(groups[1]?.text).not.toContain('prompt of call-3')
    // Inside a box, the answers are parted by one rule; a box of one has none.
    expect((await rules(ui)).length).toBe(1)
    await ui.unmount()
  })

  test('history from before prompt times: same session and same prompt share a box', async ($, on) => {
    const codex = { ...earlier(1), prompt: 'Write a short essay on climate change', sessionId: 'session-0' }
    const agy = { ...earlier(2), prompt: 'Write a short essay on climate change', sessionId: 'session-0', provider: 'agy' }
    const fish = { ...earlier(3), prompt: 'fish or chicken?', sessionId: 'session-0' }
    const otherSession = { ...earlier(4), prompt: 'Write a short essay on climate change', sessionId: 'session-9' }
    world(on, { store: { history: [codex, agy, fish, otherSession] } })
    const ui = await $.ui.mount(PANE)
    const groups = await groupBoxes(ui)
    expect(groups.length).toBe(3)
    expect(groups[0]?.text).toContain('old summary 1')
    expect(groups[0]?.text).toContain('old summary 2')
    expect((await rules(ui)).length).toBe(1)
    await ui.unmount()
  })

  test('earlier sessions group by session and prompt time; an older entry with a prompt of its own stands alone', async ($, on) => {
    const one = { ...earlier(1), sessionId: 'session-0', turnStartedAt: 400_000 }
    const two = { ...earlier(2), sessionId: 'session-0', turnStartedAt: 400_000 }
    const otherSession = { ...earlier(3), sessionId: 'session-9', turnStartedAt: 400_000 }
    const old = earlier(4)
    world(on, { store: { history: [one, two, otherSession, old] } })
    const ui = await $.ui.mount(PANE)
    const groups = await groupBoxes(ui)
    expect(groups.length).toBe(3)
    expect(groups[0]?.text).toContain('old summary 1')
    expect(groups[0]?.text).toContain('old summary 2')
    await ui.unmount()
  })

  test('this session lists the call; pressing it shows the answer and Copy copies it', async ($, on) => {
    const w = world(on)
    answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    await oneCall($, w, 'ask_codex', 'call-1')
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ text: /This session/ })).toBeDefined()
    expect(await ui.find({ text: /✓ codex/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.press({ key: 'entry:call-1' })
    const answer = await ui.find({ type: 'Markdown' })
    expect(String(answer?.props.text)).toContain('Use a tagged union')
    await ui.press({ key: 'copy-answer:call-1' })
    expect(w.seen.copies).toEqual([JSON.parse(fixtures.CODEX_ANSWER.text ?? '{}').response])
    await ui.press({ key: 'copy-prompt:call-1' })
    expect(w.seen.copies.at(-1)).toBe('prompt of call-1')
    await ui.unmount()
  })

  test('a codex image entry is titled codex image and shows its image row', async ($, on) => {
    const w = world(on)
    answerConsult(on, w.clock, fixtures.CODEX_IMAGE_ANSWER, { afterMs: 1000 })
    await oneCall($, w, 'codex_generate_image', 'img-2')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'entry:img-2' })
    expect((await ui.find({ key: 'entry:img-2' }))?.props.label).toContain('codex image')
    expect((await ui.find({ type: 'Image' }))?.props.alt).toBe('gpt cat.png · 1024×1536 · 293 KB')
    await ui.unmount()
  })

  test('an image entry links its file and Show in folder selects it', async ($, on) => {
    const w = world(on)
    answerConsult(on, w.clock, fixtures.IMAGE_ANSWER, { afterMs: 1000 })
    await oneCall($, w, 'agy_generate_image', 'img-1')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'entry:img-1' })
    const link = await ui.find({ type: 'Link' })
    expect(link?.props.href).toBe('file:///C:/proj/consult-images/red%20apple.jpg')
    expect(await ui.find({ text: /red apple\.jpg · 1024×1024 · 200 KB/ })).toBeDefined()
    await ui.press({ key: 'reveal:img-1:0' })
    expect(w.seen.processes).toEqual([['explorer.exe', '/select,C:\\proj\\consult-images\\red apple.jpg']])
    await ui.press({ key: 'open:img-1:1' })
    expect(w.seen.processes.at(-1)).toEqual(['explorer.exe', 'C:\\proj\\consult-images\\pomme é.png'])
    await ui.press({ key: 'copy-path:img-1:1' })
    expect(w.seen.copies.at(-1)).toBe('C:\\proj\\consult-images\\pomme é.png')
    expect(w.seen.toasts.at(-1)).toBe('consult: path copied')
    await ui.unmount()
  })

  test('Copy answer and Copy prompt confirm with a toast', async ($, on) => {
    const w = world(on)
    answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    await oneCall($, w, 'ask_codex', 'call-1')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'entry:call-1' })
    await ui.press({ key: 'copy-answer:call-1' })
    expect(w.seen.toasts.at(-1)).toBe('consult: answer copied')
    await ui.press({ key: 'copy-prompt:call-1' })
    expect(w.seen.toasts.at(-1)).toBe('consult: prompt copied')
    await ui.unmount()
  })

  test('a copy that did not take says why', async ($, on) => {
    const w = world(on, { copy: 'no-clipboard' })
    answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    await oneCall($, w, 'ask_codex', 'call-1')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'entry:call-1' })
    await ui.press({ key: 'copy-answer:call-1' })
    expect(w.seen.toasts.at(-1)).toBe('consult: could not copy the answer (no-clipboard)')
    await ui.unmount()
  })

  test('Open refuses a file that is not an image', async ($, on) => {
    const w = world(on)
    const text = JSON.stringify({ images: [{ path: 'C:\\proj\\consult-images\\run.bat', width: null, height: null, bytes: 10 }], output_dir: 'C:\\proj' })
    answerConsult(on, w.clock, { result: [{ type: 'text', text }], text }, { afterMs: 1000 })
    await oneCall($, w, 'agy_generate_image', 'img-1')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'entry:img-1' })
    expect(await ui.find({ key: 'open:img-1:0' })).toBeUndefined()
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.press({ key: 'reveal:img-1:0' })
    expect(w.seen.processes).toEqual([['explorer.exe', '/select,C:\\proj\\consult-images\\run.bat']])
    await ui.unmount()
  })

  test('earlier sessions show 10, then 10 more', async ($, on) => {
    const history: HistoryEntry[] = []
    for (let n = 1; n <= 12; n++) history.push(earlier(n))
    world(on, { store: { history } })
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ text: /Earlier sessions/ })).toBeDefined()
    expect((await entryKeys(ui, 'entry:old-')).length).toBe(10)
    await ui.press({ key: 'more-earlier' })
    expect((await entryKeys(ui, 'entry:old-')).length).toBe(12)
    expect(await ui.find({ key: 'more-earlier' })).toBeUndefined()
    await ui.unmount()
  })

  test('history with entries this version did not write still draws', async ($, on) => {
    world(on, { store: { history: [{ id: 'a' }, 'junk', earlier(1)] } })
    const ui = await $.ui.mount(PANE)
    expect(await entryKeys(ui, 'entry:')).toEqual(['entry:old-1'])
    await ui.unmount()
  })

  test("this session's calls are left out of earlier sessions", async ($, on) => {
    const w = world(on)
    answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    await oneCall($, w, 'ask_codex', 'call-1')
    const ui = await $.ui.mount(PANE)
    expect(await entryKeys(ui, 'entry:call-1')).toEqual(['entry:call-1'])
    await ui.unmount()
  })

  test('/consult opens the pane and a second /consult closes it', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: false })
    expect(w.seen.registered).toEqual(['consult'])
    const ran = await $.command.run({ command: 'consult', ...COMMAND } as never)
    expect(w.seen.opened).toEqual(['consult'])
    // A panel, not a transcript line: an empty text still draws "consult: ".
    expect(ran.text).toBeUndefined()
    await $.command.run({ command: 'consult', ...COMMAND } as never)
    expect(w.seen.closed).toEqual(['consult'])
  })

  test('when consult is taken, /consult-answers is registered', async ($, on) => {
    const w = world(on, { refuseCommands: ['consult'] })
    await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: false })
    expect(w.seen.registered).toEqual(['consult-answers'])
    await $.command.run({ command: 'consult-answers', ...COMMAND } as never)
    expect(w.seen.opened).toEqual(['consult'])
  })
})

const BAND = {
  plugin: PLUGIN,
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 19, bodyColumns: 80, scroll: { offset: 0, bodyRows: 18 }, view: {} },
} as const

describe('pane tabs', () => {
  test('switching to Local models and back keeps the open answer and the shown counts', async ($, on) => {
    const w = world(on)
    answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    await oneCall($, w, 'ask_codex', 'call-1')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'entry:call-1' })
    await ui.press({ key: 'tab:local' })
    expect(await ui.find({ text: /This session/ })).toBeUndefined()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.press({ key: 'tab:answers' })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    const view = w.state.pane as { expandedId: string | null; sessionShown: number; earlierShown: number }
    expect([view.expandedId, view.sessionShown, view.earlierShown]).toEqual(['call-1', 10, 10])
    await ui.unmount()
  })

  test('the tab bar marks the active tab', async ($, on) => {
    world(on)
    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ key: 'tab:answers' }))?.props.label).toBe('[Answers]')
    expect((await ui.find({ key: 'tab:local' }))?.props.label).toBe('Local models')
    await ui.press({ key: 'tab:local' })
    expect((await ui.find({ key: 'tab:answers' }))?.props.label).toBe('Answers')
    expect((await ui.find({ key: 'tab:local' }))?.props.label).toBe('[Local models]')
    await ui.unmount()
  })

  test('the inactive tab is dim, the active one full strength', async ($, on) => {
    world(on)
    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ key: 'tab:answers' }))?.props.dimColor).toBe(false)
    expect((await ui.find({ key: 'tab:local' }))?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test('the tab pressed is remembered in the store', async ($, on) => {
    const w = world(on)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'tab:local' })
    expect(w.store['pane-tab']).toBe('local')
    await ui.unmount()
  })

  test('/consult opens on the tab last used', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' } })
    await $.command.run({ command: 'consult', ...COMMAND } as never)
    expect(w.seen.opened).toEqual(['consult'])
    expect((w.state.pane as { tab: string }).tab).toBe('local')
  })

  test('a stored tab that is not a tab opens on Answers', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'tasks-from-the-future' } })
    await $.command.run({ command: 'consult', ...COMMAND } as never)
    expect((w.state.pane as { tab: string }).tab).toBe('answers')
  })

  test("the band's Answers opens on Answers whatever was used last", async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' } })
    answerConsult(on, w.clock, fixtures.CODEX_ANSWER, { afterMs: 1000 })
    await oneCall($, w, 'ask_codex', 'call-1')
    await w.clock.settle()
    // The pane was last on Local models (opened there, then closed).
    await $.command.run({ command: 'consult', ...COMMAND } as never)
    expect((w.state.pane as { tab: string }).tab).toBe('local')
    // A finished call: the band's row with its Answers button.
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'answers' })
    expect((w.state.pane as { tab: string }).tab).toBe('answers')
    await ui.unmount()
  })
})
