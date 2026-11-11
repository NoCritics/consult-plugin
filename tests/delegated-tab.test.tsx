import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { DelegateClearKind, DelegateShow, DelegateTaskRow } from '../types'
import { fenceNote } from '../hooks/mod/delegated'
import { paint, picture } from './paint'
import { DELEGATE_DATA, PLUGIN, beatInstance, delegateRow, setDelegateIndex, world } from './world'
import type { World, WorldOptions } from './world'

const NOW = 1_000_000
const PROJECT = 'C:/proj'

function paneProps(columns: number) {
  return { title: 'consult', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const
}

function paneAt(columns: number) {
  return { plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'consult', props: paneProps(columns) } as const
}

const COMMAND = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true } }

// What the server's clearPlan says of a task, for a row that does not state its own clear_kind.
function clearKindOf(row: Pick<DelegateTaskRow, 'state' | 'mode' | 'location' | 'reported_at'>): DelegateClearKind {
  if (['merged', 'cancelled', 'failed', 'stopped'].includes(row.state)) return 'now'
  if (!['done', 'held', 'conflict', 'paused-limit'].includes(row.state)) return 'refuse'
  if (row.mode === 'read') {
    if (row.state === 'conflict') return 'refuse'
    return row.reported_at === null ? 'confirm-unread' : 'now'
  }
  if (row.location === 'here') return 'confirm-in-place'
  return row.state === 'conflict' ? 'confirm-conflict' : 'confirm-discard'
}

// One task as `show` prints it.
function task(overrides: Partial<DelegateTaskRow> & { id: string }): DelegateTaskRow {
  const row: Omit<DelegateTaskRow, 'clear_kind'> & { clear_kind?: DelegateClearKind } = {
    worker: 'codex',
    model: null,
    title: 'About page',
    state: 'running',
    location: 'copy',
    mode: 'write',
    summary: null,
    fenced: true,
    fence: null,
    fence_layer: null,
    stop_reason: null,
    queue_model: null,
    reported_at: null,
    keep_running: false,
    ended_at: null,
    started_at: NOW - 12 * 60000,
    elapsed_ms: 12 * 60000,
    folder: 'C:/Users/me/.claude/consult-delegate/worktrees/aaa111',
    log_path: 'C:/Users/me/.claude/consult-delegate/tasks/aaa111/log.txt',
    report_path: null,
    merged_files: null,
    first_conflict: null,
    ...overrides,
  }
  return { ...row, clear_kind: row.clear_kind ?? clearKindOf(row) }
}

const RUNNING = task({ id: 'aaa111' })
const MERGED = task({ id: 'bbb222', title: 'Contact page', state: 'merged', started_at: NOW - 60 * 60000, elapsed_ms: 20 * 60000, merged_files: 6, reported_at: 5 })
const CONFLICT = task({ id: 'ccc333', worker: 'local', title: 'fix auth test', state: 'conflict', fenced: false, first_conflict: 'src/auth.ts', elapsed_ms: 8 * 60000, started_at: NOW - 70 * 60000, reported_at: 5 })
const QUEUED = task({ id: 'ddd444', worker: 'local', title: 'unit tests', state: 'queued', location: 'here', mode: 'read', queue_model: 'qwen3.6', started_at: null, elapsed_ms: null, fenced: null })
const DONE_READ = task({ id: 'eee555', worker: 'agy', title: 'review CSS', state: 'done', location: 'here', mode: 'read', elapsed_ms: 61000, started_at: NOW - 3 * 3600000, reported_at: 5, fenced: false, summary: 'Reviewed the CSS; three selectors repeat.' })

const SETTINGS: DelegateShow['settings'] = {
  workers_edit: 'auto',
  table: { code: 'codex', research_review: 'agy', private: 'local' },
  fence: { codex: 'fenced', agy: 'fenced', local: 'fenced' },
  local_fence_check: 'unchecked',
  local_at_once: 'auto',
  // what auto comes to now
  local_slots: 1,
  on_close: 'stop',
  time_limit_min: 180,
}

function shown(rows: DelegateTaskRow[], more: Partial<DelegateShow> = {}): DelegateShow {
  return {
    rows,
    elsewhere: [],
    limits: { codex: { level: 'ok', note: '' }, agy: { level: 'ok', note: '' }, local: { level: 'ok', note: '' } },
    settings: SETTINGS,
    git: { isRepo: true, declined: false, setupAllowed: false },
    ...more,
  }
}

const SKETCH = shown([RUNNING, MERGED, CONFLICT, QUEUED, DONE_READ], {
  limits: {
    codex: { level: 'warn', note: 'codex 5h window is 92% used; resets 14:20' },
    agy: { level: 'ok', note: '' },
    local: { level: 'ok', note: '' },
  },
})

type On = Parameters<typeof world>[0]

function mountPane($: Engine, columns: number) {
  return $.ui.mount(paneAt(columns))
}

type Opened = { w: World; ui: Awaited<ReturnType<typeof mountPane>> }

declare const console: { log: (...parts: unknown[]) => void }
declare const process: { env: Record<string, string | undefined> }

// The pane opened on the Delegated tab (as /consult does after it was last used), then drawn.
async function mountWith($: Engine, on: On, answer: (args: string[]) => unknown, options: WorldOptions = {}, columns = 100): Promise<Opened> {
  const w = world(on, { store: { 'pane-tab': 'delegated' }, delegate: answer, ...options })
  await $.command.run({ command: 'consult', ...COMMAND } as never)
  await w.clock.settle()
  const ui = await $.ui.mount(paneAt(columns))
  return { w, ui }
}

// One world whose script answers what the test last set: a case shows its own
// rows by setting them and reading again.
async function showing($: Engine, on: On, columns = 100) {
  const current = { shown: shown([]) }
  const opened = await mountWith($, on, () => current.shown, {}, columns)
  const show = async (next: DelegateShow) => {
    current.shown = next
    await opened.ui.press({ key: 'delegated:refresh' })
    await opened.w.clock.settle()
  }
  return { ...opened, show }
}

function commandsRun(w: World): string[] {
  const commands: string[] = []
  for (const run of w.seen.delegateRuns) commands.push(run.argv.slice(3).join(' '))
  return commands
}

async function lines(ui: Opened['ui'], columns: number): Promise<string[]> {
  return paint(await ui.drawn(), columns)
}

function lineWith(all: string[], pattern: RegExp): string | undefined {
  for (const line of all) {
    if (pattern.test(line)) return line
  }
  return undefined
}

describe('delegated tab', () => {
  test('three tabs are drawn, and the Delegated one is marked when it is the one shown', async ($, on) => {
    const { ui } = await mountWith($, on, () => SKETCH)
    expect((await ui.find({ key: 'tab:answers' }))?.props.label).toBe('Answers')
    expect((await ui.find({ key: 'tab:local' }))?.props.label).toBe('Local models')
    expect((await ui.find({ key: 'tab:delegated' }))?.props.label).toBe('[Delegated]')
    expect((await ui.find({ key: 'tab:delegated' }))?.props.dimColor).toBe(false)
    expect((await ui.find({ key: 'tab:answers' }))?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test('pressing the tab shows it, remembers it, and reads the tasks with delegate.js show from the plugin folder', async ($, on) => {
    const w = world(on, { delegate: () => SKETCH })
    const ui = await $.ui.mount(paneAt(100))
    expect(w.seen.delegateRuns.length).toBe(0)
    await ui.press({ key: 'tab:delegated' })
    await w.clock.settle()
    expect(w.store['pane-tab']).toBe('delegated')
    const run = w.seen.delegateRuns[0]
    expect(run?.argv[0]).toBe('node')
    expect(run?.argv.slice(2)).toEqual([PROJECT, 'show'])
    expect(run?.argv[1]?.replace(/\\/g, '/').endsWith('/hooks/scripts/delegate.js')).toBe(true)
    expect(run?.cwd?.replace(/\\/g, '/')).toBe(run?.argv[1]?.replace(/\\/g, '/').replace(/\/hooks\/scripts\/delegate\.js$/, ''))
    expect(run?.timeoutMs).toBe(10000)
    expect(await ui.find({ text: /About page/ })).toBeDefined()
    await ui.unmount()
  })

  test('the tab is remembered: /consult opens on Delegated', async ($, on) => {
    const { w } = await mountWith($, on, () => SKETCH)
    expect(w.seen.opened).toEqual(['consult'])
    expect(commandsRun(w)).toEqual(['show'])
  })

  test('each row shows its mark, worker, title, state label, where it ran, time and button', async ($, on) => {
    const { ui } = await mountWith($, on, () => SKETCH)
    const all = await lines(ui, 100)
    expect(lineWith(all, /^● codex\s+About page\s+running\s+copy\s+12m\s+\[ Cancel \]$/)).toBeDefined()
    expect(lineWith(all, /^✓ codex\s+Contact page\s+merged · 6 files\s+copy\s+20m\s+\[ Clear \]$/)).toBeDefined()
    expect(lineWith(all, /^! local\s+fix auth test\s+conflict · src\/auth\.ts\s+copy\s+8m00s\s+\[ Discard \]$/)).toBeDefined()
    expect(lineWith(all, /^… local\s+unit tests\s+queued · waits for qwen3\.6\s+here\s+\[ Cancel \]$/)).toBeDefined()
    expect(lineWith(all, /^✓ agy\s+review CSS\s+done · read only\s+here\s+1m01s\s+\[ Clear \]$/)).toBeDefined()
    await ui.unmount()
  })

  test('every state has its label and mark', async ($, on) => {
    const cases: { row: DelegateTaskRow; line: RegExp }[] = [
      { row: task({ id: 'a00001', state: 'running', location: 'here' }), line: /^● codex\s+About page\s+running\s+here\s/ },
      { row: task({ id: 'a00002', state: 'queued', queue_model: null, started_at: null, elapsed_ms: null }), line: /^… codex\s+About page\s+queued\s+copy\s+\[ Cancel \]$/ },
      { row: task({ id: 'a00003', state: 'done' }), line: /^✓ codex\s+About page\s+done\s+copy\s/ },
      { row: task({ id: 'a00004', state: 'done', mode: 'read', location: 'here', reported_at: null }), line: /^✓ codex\s+About page\s+done · read only\s+here\s/ },
      { row: task({ id: 'a00005', state: 'merged', merged_files: 1 }), line: /^✓ codex\s+About page\s+merged · 1 file\s+copy\s/ },
      { row: task({ id: 'a00006', state: 'conflict', first_conflict: 'a.txt' }), line: /^! codex\s+About page\s+conflict · a\.txt\s+copy\s/ },
      { row: task({ id: 'a00007', state: 'held' }), line: /^! codex\s+About page\s+held · for review\s+copy\s/ },
      { row: task({ id: 'a00008', state: 'paused-limit', location: 'here' }), line: /^! codex\s+About page\s+paused · limit\s+here\s/ },
      { row: task({ id: 'a00009', state: 'stopped', stop_reason: 'time-limit' }), line: /^■ codex\s+About page\s+stopped · time-limit\s+copy\s/ },
      { row: task({ id: 'a0000a', state: 'cancelled', location: 'here' }), line: /^■ codex\s+About page\s+cancelled\s+here\s/ },
      { row: task({ id: 'a0000b', state: 'failed' }), line: /^! codex\s+About page\s+failed\s+copy\s/ },
    ]
    const { ui, show } = await showing($, on)
    for (const one of cases) {
      await show(shown([one.row]))
      const all = await lines(ui, 100)
      expect(lineWith(all, one.line), `${one.row.state}: ${all.join(' / ')}`).toBeDefined()
    }
    await ui.unmount()
  })

  test('each state has the one button that fits it', async ($, on) => {
    const cases: { row: DelegateTaskRow; button: string | null }[] = [
      { row: task({ id: 'b00001', state: 'running' }), button: 'cancel' },
      { row: task({ id: 'b00002', state: 'queued' }), button: 'cancel' },
      { row: task({ id: 'b00003', state: 'merged' }), button: 'clear' },
      { row: task({ id: 'b00004', state: 'cancelled' }), button: 'clear' },
      { row: task({ id: 'b00005', state: 'failed' }), button: 'clear' },
      { row: task({ id: 'b00006', state: 'stopped' }), button: 'clear' },
      { row: task({ id: 'b00007', state: 'done', mode: 'read', reported_at: 9 }), button: 'clear' },
      { row: task({ id: 'b00008', state: 'done', mode: 'read', reported_at: null }), button: 'clear' },
      { row: task({ id: 'b00009', state: 'done', mode: 'write' }), button: 'discard' },
      { row: task({ id: 'b0000a', state: 'held' }), button: 'discard' },
      { row: task({ id: 'b0000b', state: 'conflict' }), button: 'discard' },
      { row: task({ id: 'b0000c', state: 'paused-limit' }), button: 'discard' },
      // A write task that worked in place has its edits in the project already: its record is cleared, not discarded.
      { row: task({ id: 'b00010', state: 'done', location: 'here' }), button: 'clear' },
      { row: task({ id: 'b00011', state: 'held', location: 'here' }), button: 'clear' },
      { row: task({ id: 'b00012', state: 'conflict', location: 'here' }), button: 'clear' },
      { row: task({ id: 'b00013', state: 'paused-limit', location: 'here' }), button: 'clear' },
      // A read-only task has no changes to throw away: no Discard, but a held or paused one can be cleared.
      { row: task({ id: 'b0000d', state: 'held', mode: 'read' }), button: 'clear' },
      { row: task({ id: 'b0000e', state: 'paused-limit', mode: 'read' }), button: 'clear' },
      { row: task({ id: 'b0000f', state: 'conflict', mode: 'read' }), button: null },
    ]
    const { ui, show } = await showing($, on)
    for (const one of cases) {
      await show(shown([one.row]))
      const found: string[] = []
      for (const button of await ui.findAll({ type: 'Button' })) {
        if (button.key !== undefined && button.key.endsWith(`:${one.row.id}`) && !button.key.startsWith('delegated:row:')) found.push(button.key.split(':')[1] as string)
      }
      expect(found, `${one.row.state} ${one.row.mode}`).toEqual(one.button === null ? [] : [one.button])
    }
    await ui.unmount()
  })

  test('Cancel sends cancel with the id, then reads again', async ($, on) => {
    const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { cancelling: true }))
    await ui.press({ key: 'delegated:cancel:aaa111' })
    await w.clock.settle()
    expect(commandsRun(w)).toEqual(['show', 'cancel aaa111', 'show'])
    await ui.unmount()
  })

  test('Clear sends clear with the id and no discard, then reads again', async ($, on) => {
    const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { cleared: 'bbb222' }))
    await ui.press({ key: 'delegated:clear:bbb222' })
    await w.clock.settle()
    expect(commandsRun(w)).toEqual(['show', 'clear bbb222', 'show'])
    await ui.unmount()
  })

  test('Discard asks first, and No sends nothing', async ($, on) => {
    const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { cleared: 'ccc333' }), {}, 160)
    await ui.press({ key: 'delegated:discard:ccc333' })
    await w.clock.settle()
    expect(commandsRun(w)).toEqual(['show'])
    const asked = lineWith(await lines(ui, 160), /^\s*Discard "fix auth test"\? Its merged changes stay in the project; the copy and its branch consult\/ccc333 are removed\./)
    expect(asked).toBeDefined()
    expect(asked).toMatch(/\[ Yes \]\s+\[ No \]$/)
    await ui.press({ key: 'delegated:confirm-no:ccc333' })
    await w.clock.settle()
    expect(commandsRun(w)).toEqual(['show'])
    expect(lineWith(await lines(ui, 100), /Its merged changes stay in the project/)).toBeUndefined()
    expect(await ui.find({ key: 'delegated:discard:ccc333' })).toBeDefined()
    await ui.unmount()
  })

  test('Discard then Yes sends clear with discard true, then reads again', async ($, on) => {
    const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { cleared: 'ccc333' }))
    await ui.press({ key: 'delegated:discard:ccc333' })
    await ui.press({ key: 'delegated:confirm-yes:ccc333' })
    await w.clock.settle()
    expect(commandsRun(w)).toEqual(['show', 'clear ccc333 {"discard":true}', 'show'])
    expect(lineWith(await lines(ui, 100), /Its changes will be lost/)).toBeUndefined()
    await ui.unmount()
  })

  describe('an ended task that worked in place', () => {
    const IN_PLACE = task({ id: 'iii999', title: 'Fix header', state: 'done', location: 'here', mode: 'write' })

    test('asks "Its edits stay in the project", not that its changes are lost, and No sends nothing', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([IN_PLACE]) : { cleared: 'iii999' }))
      await ui.press({ key: 'delegated:clear:iii999' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show'])
      const asked = lineWith(await lines(ui, 100), /^\s*Clear "Fix header"\?/)
      expect(asked).toMatch(/^\s*Clear "Fix header"\? Its edits stay in the project; only the task's record goes\.\s+\[ Yes \]\s+\[ No \]$/)
      expect(lineWith(await lines(ui, 100), /will be lost/)).toBeUndefined()
      await ui.press({ key: 'delegated:confirm-no:iii999' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show'])
      expect(lineWith(await lines(ui, 100), /^\s*Clear "Fix header"\?/)).toBeUndefined()
      await ui.unmount()
    })

    test('Yes sends clear with discard true (the server refuses an unmerged task otherwise), then reads again', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([IN_PLACE]) : { cleared: 'iii999' }))
      await ui.press({ key: 'delegated:clear:iii999' })
      await ui.press({ key: 'delegated:confirm-yes:iii999' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show', 'clear iii999 {"discard":true}', 'show'])
      await ui.unmount()
    })
  })

  describe('a read-only task whose result Claude has not read', () => {
    const UNREAD = task({ id: 'rrr777', title: 'review CSS', state: 'done', location: 'here', mode: 'read', reported_at: null })
    const READ = task({ id: 'sss888', title: 'review JS', state: 'done', location: 'here', mode: 'read', reported_at: 5 })

    test('Clear asks that Claude has not read its result, and No sends nothing', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([UNREAD]) : { cleared: 'rrr777' }))
      await ui.press({ key: 'delegated:clear:rrr777' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show'])
      const asked = lineWith(await lines(ui, 100), /^\s*Clear "review CSS"\?/)
      expect(asked).toMatch(/^\s*Clear "review CSS"\? Claude hasn't read its result\.\s+\[ Yes \]\s+\[ No \]$/)
      await ui.press({ key: 'delegated:confirm-no:rrr777' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show'])
      expect(lineWith(await lines(ui, 100), /Claude hasn't read/)).toBeUndefined()
      await ui.unmount()
    })

    test('Yes sends clear with discard true (the server refuses an unread answer otherwise), then reads again', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([UNREAD]) : { cleared: 'rrr777' }))
      await ui.press({ key: 'delegated:clear:rrr777' })
      await ui.press({ key: 'delegated:confirm-yes:rrr777' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show', 'clear rrr777 {"discard":true}', 'show'])
      await ui.unmount()
    })

    for (const state of ['held', 'paused-limit'] as const) {
      test(`a read-only ${state} one is cleared with the same question and discard true`, async ($, on) => {
        const stuck = task({ id: 'ttt999', title: 'review HTML', state, location: 'here', mode: 'read', reported_at: null })
        const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([stuck]) : { cleared: 'ttt999' }))
        await ui.press({ key: 'delegated:clear:ttt999' })
        await w.clock.settle()
        expect(commandsRun(w)).toEqual(['show'])
        expect(lineWith(await lines(ui, 100), /^\s*Clear "review HTML"\? Claude hasn't read its result\./)).toBeDefined()
        await ui.press({ key: 'delegated:confirm-yes:ttt999' })
        await w.clock.settle()
        expect(commandsRun(w)).toEqual(['show', 'clear ttt999 {"discard":true}', 'show'])
        await ui.unmount()
      })
    }

    test('a read one keeps a plain Clear that asks nothing', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([READ]) : { cleared: 'sss888' }))
      await ui.press({ key: 'delegated:clear:sss888' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show', 'clear sss888', 'show'])
      await ui.unmount()
    })
  })

  describe('a question that is open', () => {
    test('closes when a read finds the task in another state, and Yes then sends nothing', async ($, on) => {
      const current = { shown: SKETCH }
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? current.shown : { cleared: 'ccc333' }))
      await ui.press({ key: 'delegated:discard:ccc333' })
      expect(lineWith(await lines(ui, 100), /Its merged changes stay in the project/)).toBeDefined()
      // Claude sent a follow-up: the task ran again.
      current.shown = shown([RUNNING, task({ ...CONFLICT, state: 'running', ended_at: null }), MERGED])
      await ui.press({ key: 'delegated:refresh' })
      await w.clock.settle()
      expect(lineWith(await lines(ui, 100), /Its merged changes stay in the project/)).toBeUndefined()
      expect(await ui.find({ key: 'delegated:confirm-yes:ccc333' })).toBeUndefined()
      expect(commandsRun(w).filter(command => command.startsWith('clear'))).toEqual([])
      await ui.unmount()
    })

    test('closes when the task ended again (another run, the same state)', async ($, on) => {
      const current = { shown: shown([task({ id: 'jjj000', state: 'done', ended_at: 5000 })]) }
      const { ui, w } = await mountWith($, on, () => current.shown)
      await ui.press({ key: 'delegated:discard:jjj000' })
      expect(lineWith(await lines(ui, 100), /Its changes will be lost/)).toBeDefined()
      current.shown = shown([task({ id: 'jjj000', state: 'done', ended_at: 9000 })])
      await ui.press({ key: 'delegated:refresh' })
      await w.clock.settle()
      expect(lineWith(await lines(ui, 100), /Its changes will be lost/)).toBeUndefined()
      await ui.unmount()
    })

    test('stays open when a read finds the task as it was', async ($, on) => {
      const { ui, w } = await mountWith($, on, () => SKETCH)
      await ui.press({ key: 'delegated:discard:ccc333' })
      await ui.press({ key: 'delegated:refresh' })
      await w.clock.settle()
      expect(lineWith(await lines(ui, 100), /Its merged changes stay in the project/)).toBeDefined()
      await ui.unmount()
    })

    test('at 44 columns it keeps to one line with both buttons whole', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH, {}, 44)
      await ui.press({ key: 'delegated:discard:ccc333' })
      const all = await lines(ui, 44)
      const question: string[] = []
      for (const line of all) {
        if (/Yes|\[ No \]|Discard "/.test(line)) question.push(line)
      }
      expect(question.length).toBe(1)
      expect(question[0]).toMatch(/\[ Yes \]\s+\[ No \]$/)
      expect((question[0] ?? '').length).toBeLessThanOrEqual(44)
      await ui.unmount()
    })
  })

  test('a row that Discard asked about is not asked about again after another is pressed', async ($, on) => {
    const { ui } = await mountWith($, on, () => SKETCH)
    await ui.press({ key: 'delegated:discard:ccc333' })
    await ui.press({ key: 'delegated:cancel:aaa111' })
    expect(lineWith(await lines(ui, 100), /Its changes will be lost/)).toBeUndefined()
    await ui.unmount()
  })

  test('an { error } from the script is drawn inline and the rows stay', async ($, on) => {
    const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { error: 'A merge is in progress, so the task cannot be cleared right now.' }))
    await ui.press({ key: 'delegated:clear:bbb222' })
    await w.clock.settle()
    const error = await ui.find({ type: 'Text', text: /A merge is in progress/ })
    expect(error?.props.color).toBe('error')
    expect(await ui.find({ text: /Contact page/ })).toBeDefined()
    await ui.unmount()
  })

  test('a show that fails says so, and the next one clears it', async ($, on) => {
    let failing = true
    const { w, ui } = await mountWith($, on, () => (failing ? { error: 'no data folder' } : SKETCH))
    expect((await ui.find({ type: 'Text', text: /no data folder/ }))?.props.color).toBe('error')
    failing = false
    await ui.press({ key: 'delegated:refresh' })
    await w.clock.settle()
    expect(await ui.find({ text: /no data folder/ })).toBeUndefined()
    expect(await ui.find({ text: /About page/ })).toBeDefined()
    await ui.unmount()
  })

  test('a script that hangs is given up on after 10 s', async ($, on) => {
    const { w, ui } = await mountWith($, on, () => 'hang')
    await w.clock.advance(10_500)
    expect(await ui.find({ type: 'Text', text: /didn't answer in 10 s/ })).toBeDefined()
    expect(w.seen.delegateRuns[0]?.timeoutMs).toBe(10000)
    await ui.unmount()
  })

  describe('time limits', () => {
    test('cancel, stop-all and save keep 10 s', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : 'hang'))
      // A press waits for its action, so the clock moves while it is pending.
      const pressed = ui.press({ key: 'delegated:cancel:aaa111' })
      await w.clock.advance(10_500)
      await pressed
      expect(await ui.find({ type: 'Text', text: /didn't answer in 10 s/ })).toBeDefined()
      const limits: Record<string, number | undefined> = {}
      for (const run of w.seen.delegateRuns) limits[run.argv[3] ?? ''] = run.timeoutMs
      expect(limits).toEqual({ show: 10000, cancel: 10000 })
      await ui.unmount()
    })

    test('clear gets 60 s: the timer, the kill and the text', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : 'hang'))
      const pressed = ui.press({ key: 'delegated:clear:bbb222' })
      await w.clock.advance(30_000)
      expect(await ui.find({ type: 'Text', text: /didn't answer/ })).toBeUndefined()
      await w.clock.advance(30_500)
      await pressed
      expect(await ui.find({ type: 'Text', text: /didn't answer in 60 s/ })).toBeDefined()
      const clearRun = w.seen.delegateRuns.find(run => run.argv[3] === 'clear')
      expect(clearRun?.timeoutMs).toBe(60000)
      await ui.unmount()
    })

    test('the clear a Discard sends gets 60 s too', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : 'hang'))
      await ui.press({ key: 'delegated:discard:ccc333' })
      const pressed = ui.press({ key: 'delegated:confirm-yes:ccc333' })
      await w.clock.advance(30_000)
      expect(await ui.find({ type: 'Text', text: /didn't answer/ })).toBeUndefined()
      await w.clock.advance(30_500)
      await pressed
      expect(await ui.find({ type: 'Text', text: /didn't answer in 60 s/ })).toBeDefined()
      expect(w.seen.delegateRuns.find(run => run.argv[3] === 'clear')?.timeoutMs).toBe(60000)
      await ui.unmount()
    })
  })

  describe('while an action runs', () => {
    test('its state cell says so, the button keeps its label and goes dim, and a second press sends nothing', async ($, on) => {
      let release: (value: unknown) => void = () => {}
      const { w, ui } = await mountWith($, on, args => {
        if (args[0] === 'show') return SKETCH
        return new Promise(resolve => { release = resolve })
      })
      const first = ui.press({ key: 'delegated:clear:bbb222' })
      await w.clock.settle()
      const busyButton = await ui.find({ key: 'delegated:clear:bbb222' })
      expect([busyButton?.props.label, busyButton?.props.dimColor]).toEqual(['Clear', true])
      expect(lineWith(await lines(ui, 100), /^✓ codex\s+Contact page\s+clearing…\s+copy\s+20m\s+\[ Clear \]$/)).toBeDefined()
      await ui.press({ key: 'delegated:clear:bbb222' })
      await ui.press({ key: 'delegated:clear:bbb222' })
      expect(commandsRun(w).filter(command => command.startsWith('clear'))).toEqual(['clear bbb222'])
      release({ cleared: 'bbb222' })
      await first
      expect((await ui.find({ key: 'delegated:clear:bbb222' }))?.props.dimColor).toBe(false)
      expect(commandsRun(w).filter(command => command.startsWith('clear'))).toEqual(['clear bbb222'])
      await ui.unmount()
    })

    test('Cancel says cancelling… in its row and Stop all says Stopping…, and each runs once', async ($, on) => {
      const releases: ((value: unknown) => void)[] = []
      const { w, ui } = await mountWith($, on, args => {
        if (args[0] === 'show') return SKETCH
        return new Promise(resolve => { releases.push(resolve) })
      })
      const cancelling = ui.press({ key: 'delegated:cancel:aaa111' })
      await ui.press({ key: 'delegated:stop-all' })
      const stopping = ui.press({ key: 'delegated:stop-all-yes' })
      await w.clock.settle()
      expect(lineWith(await lines(ui, 100), /^● codex\s+About page\s+cancelling…\s+copy\s+12m\s+\[ Cancel \]$/)).toBeDefined()
      expect((await ui.find({ key: 'delegated:cancel:aaa111' }))?.props.label).toBe('Cancel')
      expect((await ui.find({ key: 'delegated:stop-all' }))?.props.label).toBe('Stopping…')
      await ui.press({ key: 'delegated:cancel:aaa111' })
      await ui.press({ key: 'delegated:stop-all' })
      expect(commandsRun(w).filter(command => command !== 'show').length).toBe(2)
      for (const release of releases) release({ cancelling: true, stopped: [], failed: [] })
      await cancelling
      await stopping
      await ui.unmount()
    })

    test('a Discard answered Yes shows clearing… on its row, and one press of Yes sends one clear', async ($, on) => {
      let release: (value: unknown) => void = () => {}
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : new Promise(resolve => { release = resolve })))
      await ui.press({ key: 'delegated:discard:ccc333' })
      // The action answers only when released, so the press is in flight while the row is checked.
      const answering = ui.press({ key: 'delegated:confirm-yes:ccc333' })
      await w.clock.settle()
      expect(commandsRun(w).filter(command => command.startsWith('clear'))).toEqual(['clear ccc333 {"discard":true}'])
      expect(lineWith(await lines(ui, 100), /^! local\s+fix auth test\s+clearing…\s+copy\s+8m00s\s+\[ Discard \]$/)).toBeDefined()
      expect(await ui.find({ key: 'delegated:confirm-yes:ccc333' })).toBeUndefined()
      release({ cleared: 'ccc333' })
      await answering
      await ui.unmount()
    })
  })

  test('two reads in flight: the older answer landing last does not replace the newer', async ($, on) => {
    const answers: ((value: unknown) => void)[] = []
    const { w, ui } = await mountWith($, on, () => new Promise(resolve => { answers.push(resolve) }), {}, 100)
    // The tab's own read is the first; two presses of Refresh at once are the next two.
    const pressed = [ui.press({ key: 'delegated:refresh' }), ui.press({ key: 'delegated:refresh' })]
    await w.clock.settle()
    expect(answers.length).toBe(3)
    answers[2]?.(shown([task({ id: 'new001', title: 'Newer read' })]))
    await w.clock.settle()
    answers[1]?.(shown([task({ id: 'old001', title: 'Older read' })]))
    answers[0]?.(shown([task({ id: 'old000', title: 'Oldest read' })]))
    await Promise.all(pressed)
    await w.clock.settle()
    expect(await ui.find({ text: /Newer read/ })).toBeDefined()
    expect(await ui.find({ text: /Older read/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a surface that draws no fields still lists the tasks, with no settings', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'delegated' }, delegate: () => SKETCH })
    await $.command.run({ command: 'consult', ...COMMAND } as never)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...paneAt(100), surface: 'mobile' } as never)
    expect(await ui.find({ text: /About page/ })).toBeDefined()
    expect(await ui.find({ key: 'delegated:fold' })).toBeUndefined()
    await ui.unmount()
  })

  test('with no tasks the tab says so', async ($, on) => {
    const { ui } = await mountWith($, on, () => shown([]))
    expect(lineWith(await lines(ui, 100), /^No delegated tasks yet/)).toBeDefined()
    await ui.unmount()
  })

  describe('Stop all', () => {
    test('is absent with nothing running or queued', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([MERGED, DONE_READ, CONFLICT]))
      expect(await ui.find({ key: 'delegated:stop-all' })).toBeUndefined()
      await ui.unmount()
    })

    test('counts the tasks running or queued, in every project', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([RUNNING, QUEUED, MERGED], { elsewhere: [{ project: 'C:/other/site', finished: 0, running: 2 }] }) : { stopped: ['x'], failed: [] }))
      expect((await ui.find({ key: 'delegated:stop-all' }))?.props.label).toBe('Stop all (4)')
      await ui.press({ key: 'delegated:stop-all' })
      await ui.press({ key: 'delegated:stop-all-yes' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show', 'stop-all', 'show'])
      await ui.unmount()
    })

    test('a task it could not stop is drawn inline', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([RUNNING]) : { stopped: [], failed: [{ id: 'aaa111', error: 'access denied' }] }))
      await ui.press({ key: 'delegated:stop-all' })
      await ui.press({ key: 'delegated:stop-all-yes' })
      await w.clock.settle()
      expect((await ui.find({ type: 'Text', text: /could not stop.*access denied/ }))?.props.color).toBe('error')
      await ui.unmount()
    })
  })

  describe('under the rows', () => {
    test('the usage line gives each worker its note, or ok', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH)
      const all = await lines(ui, 100)
      expect(lineWith(all, /^codex 5h window is 92% used; resets 14:20$/)).toBeDefined()
      expect(lineWith(all, /^agy ok · local ok$/)).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^codex 5h window/ }))?.props.color).toBe('warning')
      await ui.unmount()
    })

    test('a worker that hit its limit is drawn in the error colour, and a stale figure keeps its age', async ($, on) => {
      const limited = shown([RUNNING], { limits: { codex: { level: 'full', note: 'codex hit its limit; resets 14:20 (figures from 3 h ago)' }, agy: { level: 'ok', note: '' }, local: { level: 'ok', note: '' } } })
      const { ui } = await mountWith($, on, () => limited)
      const text = await ui.find({ type: 'Text', text: /^codex hit its limit/ })
      expect(text?.props.color).toBe('error')
      expect(text?.text).toContain('figures from 3 h ago')
      await ui.unmount()
    })

    test('the on-close line says what happens, and "change" opens the settings on that choice', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH)
      expect(lineWith(await lines(ui, 100), /^Tasks stop when Claude Code closes · change$/)).toBeDefined()
      expect(await ui.find({ key: 'delegated:set:on_close' })).toBeUndefined()
      await ui.press({ key: 'delegated:on-close-change' })
      const select = await ui.find({ key: 'delegated:set:on_close' })
      expect(select).toBeDefined()
      await ui.unmount()
    })

    // The kit has no answer for the mod's own $.ui.focus ("no implementation for
    // ui.focus"; a hook in the test never sees the call), so the call itself
    // cannot be observed here: it is made inside a try, which this test relies
    // on. What can be seen is the fold, and that no autoFocus is drawn any more.
    test('"change" opens the fold on the on-close choice, with no autoFocus, and a failing $.ui.focus does not break it', async ($, on) => {
      const { w, ui } = await mountWith($, on, () => SKETCH)
      await ui.press({ key: 'delegated:on-close-change' })
      const select = await ui.find({ key: 'delegated:set:on_close' })
      expect(select).toBeDefined()
      expect(select?.props.autoFocus).toBeUndefined()
      expect(await ui.find({ key: 'delegated:save' })).toBeDefined()
      // Pressed again with the fold open, it stays open.
      await ui.press({ key: 'delegated:on-close-change' })
      expect(await ui.find({ key: 'delegated:set:on_close' })).toBeDefined()
      expect(w.seen.toasts).toEqual([])
      await ui.unmount()
    })

    test('the on-close line reads the other way when tasks keep running', async ($, on) => {
      const keeping = shown([RUNNING], { settings: { ...SETTINGS, on_close: 'keep' } })
      const { ui } = await mountWith($, on, () => keeping)
      expect(lineWith(await lines(ui, 100), /^Tasks keep running after Claude Code closes · change$/)).toBeDefined()
      await ui.unmount()
    })

    test('"no git here" shows only when git was declined', async ($, on) => {
      const { ui, show } = await showing($, on)
      await show(shown([RUNNING], { git: { isRepo: false, declined: true, setupAllowed: true } }))
      const dim = await ui.find({ type: 'Text', text: /^no git here · workers edit in place$/ })
      expect(dim?.props.dimColor).toBe(true)
      await show(SKETCH)
      expect(await ui.find({ text: /no git here/ })).toBeUndefined()
      await ui.unmount()
    })

    test('no git switch or init button is drawn', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([RUNNING], { git: { isRepo: false, declined: true, setupAllowed: true } }))
      for (const button of await ui.findAll({ type: 'Button' })) expect(button.key ?? '').not.toMatch(/git/)
      await ui.unmount()
    })

    test('other projects with finished tasks get one dim line each; running ones add nothing', async ($, on) => {
      const elsewhere = [
        { project: 'C:/Users/me/source/claude-plugins', finished: 2, running: 0 },
        { project: 'C:/other/site', finished: 1, running: 0 },
        { project: 'C:/quiet', finished: 0, running: 1 },
      ]
      const { ui } = await mountWith($, on, () => shown([MERGED], { elsewhere }))
      const all = await lines(ui, 100)
      expect(lineWith(all, /^2 tasks finished in claude-plugins; open a session there to merge$/)).toBeDefined()
      expect(lineWith(all, /^1 task finished in site; open a session there to merge$/)).toBeDefined()
      expect(lineWith(all, /quiet/)).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: /finished in claude-plugins/ }))?.props.dimColor).toBe(true)
      await ui.unmount()
    })
  })

  describe('selecting a row', () => {
    test('shows its summary, folder and log path', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH)
      expect(lineWith(await lines(ui, 100), /Reviewed the CSS/)).toBeUndefined()
      await ui.press({ key: 'delegated:row:eee555' })
      const all = await lines(ui, 100)
      expect(lineWith(all, /^\s+Reviewed the CSS; three selectors repeat\.$/)).toBeDefined()
      expect(lineWith(all, /^\s+folder\s+C:\/Users\/me\/.*aaa111$/)).toBeDefined()
      expect(lineWith(all, /^\s+log\s+C:\/Users\/me\/.*log\.txt$/)).toBeDefined()
      // Both paths are Links to a file:/// URL.
      const hrefs: unknown[] = []
      for (const link of await ui.findAll({ type: 'Link' })) hrefs.push(link.props.href)
      expect(hrefs).toEqual(['file:///C:/Users/me/.claude/consult-delegate/worktrees/aaa111', 'file:///C:/Users/me/.claude/consult-delegate/tasks/aaa111/log.txt'])
      await ui.press({ key: 'delegated:row:eee555' })
      expect(lineWith(await lines(ui, 100), /Reviewed the CSS/)).toBeUndefined()
      await ui.unmount()
    })

    test('a local row run under the guard says "edits checked"; a Codex row and a sandboxed local row say nothing', async ($, on) => {
      const guarded = task({ id: 'ccc333', worker: 'local', title: 'fix auth test', fenced: false, fence: 'fenced', fence_layer: 'guard' })
      const sandboxed = task({ id: 'ccc444', worker: 'local', title: 'other test', fenced: true, fence: 'fenced', fence_layer: 'sandbox' })
      const { ui } = await mountWith($, on, () => shown([RUNNING, guarded, sandboxed]))
      await ui.press({ key: 'delegated:row:ccc333' })
      expect(lineWith(await lines(ui, 100), /^\s+edits checked$/)).toBeDefined()
      expect(lineWith(await lines(ui, 100), /^\s+edits checked · /)).toBeUndefined()
      expect(lineWith(await lines(ui, 100), /not fenced/)).toBeUndefined()
      await ui.press({ key: 'delegated:row:ccc444' })
      expect(lineWith(await lines(ui, 100), /edits checked|not fenced/)).toBeUndefined()
      await ui.press({ key: 'delegated:row:aaa111' })
      expect(lineWith(await lines(ui, 100), /edits checked|not fenced/)).toBeUndefined()
      await ui.unmount()
    })

    test('an agy row says "can\'t run commands" on one warning line, and nothing about the fence', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH)
      await ui.press({ key: 'delegated:row:eee555' })
      const all = await lines(ui, 100)
      expect(lineWith(all, /^\s+can't run commands$/)).toBeDefined()
      expect(lineWith(all, /not fenced/)).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: /^can't run commands$/ }))?.props.color).toBe('warning')
      await ui.unmount()
    })

    test('a running local row says it keeps the GPU busy only when tasks keep running after close', async ($, on) => {
      const keepsRunning = task({ id: 'fff666', worker: 'local', title: 'big job', state: 'running', keep_running: true, fenced: false })
      const stopsOnClose = task({ id: 'ggg777', worker: 'local', title: 'other job', state: 'running', keep_running: false, fenced: false })
      const { ui } = await mountWith($, on, () => shown([keepsRunning, stopsOnClose]))
      await ui.press({ key: 'delegated:row:fff666' })
      expect(lineWith(await lines(ui, 100), /^\s+keeps the GPU busy and its model loaded$/)).toBeDefined()
      await ui.press({ key: 'delegated:row:ggg777' })
      expect(lineWith(await lines(ui, 100), /keeps the GPU busy/)).toBeUndefined()
      await ui.unmount()
    })
  })

  describe('narrow width', () => {
    for (const columns of [44, 89]) {
      test(`at ${columns} columns every cell of a row keeps its width: the title is cut by its computed cell, nothing wraps or glues`, async ($, on) => {
        const { ui } = await mountWith($, on, () => SKETCH, {}, columns)
        const rowBox = await ui.find({ type: 'Box', key: 'delegated:line:aaa111' })
        expect(rowBox).toBeDefined()
        const parts = (rowBox?.children ?? []) as { type: string; props: Record<string, unknown> }[]
        for (const part of parts) expect(part.props.flexShrink).toBe(0)
        await ui.unmount()
      })
    }

    test('a narrow row is two lines: mark, worker, title and button, then its state, where and time dim', async ($, on) => {
      const long = task({ id: 'hhh888', title: 'Rebuild the whole checkout flow with the new payment provider' })
      const { ui } = await mountWith($, on, () => shown([long, MERGED, CONFLICT, QUEUED]), {}, 44)
      const all = await lines(ui, 44)
      for (const line of all) expect(line.length, line).toBeLessThanOrEqual(44)
      const first = all.findIndex(line => /^● codex/.test(line))
      // Title cell 44 - (2 + 5 + 2 + 2 + 11): the Discard button is the widest.
      expect(all[first]).toBe('● codex  Rebuild the whole che…  [ Cancel ]')
      expect(all[first + 1]).toBe('    running · in a copy · 12m')
      expect(all[first + 2]).toMatch(/^✓ codex {2}Contact page {10,}\[ Clear \]$/)
      expect(all[first + 3]).toBe('    merged · 6 files · in a copy · 20m')
      expect(all[first + 4]).toMatch(/\[ Discard \]$/)
      expect(all[first + 5]).toBe('    conflict · src/auth… · in a copy · 8m00s')
      expect(all[first + 6]).toMatch(/^… local {2}unit tests {2,}\[ Cancel \]$/)
      expect(all[first + 7]).toBe('    queued · waits for qwen3.6 · here')
      // The second line is dim, except a problem state, which keeps its colour.
      expect((await ui.find({ type: 'Text', text: /^ · in a copy · 12m$/ }))?.props.dimColor).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^conflict · src\/auth\.ts/ }))?.props.color).toBe('warning')
      await ui.unmount()
    })

    test('a narrow pane has no hint line and short on-close words', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH, {}, 44)
      const all = await lines(ui, 44)
      expect(lineWith(all, /press a task/)).toBeUndefined()
      expect(lineWith(all, /^On close: tasks stop · change$/)).toBeDefined()
      await ui.unmount()
    })

    test('at 70 columns the where cell is there and the long title is what is cut', async ($, on) => {
      const long = task({ id: 'hhh888', title: 'Rebuild the whole checkout flow with the new payment provider' })
      const { ui } = await mountWith($, on, () => shown([long]), {}, 70)
      const all = await lines(ui, 70)
      const row = lineWith(all, /^● codex/)
      expect(row).toMatch(/^● codex\s+Rebuild.*…\s+running\s+copy\s+12m\s+\[ Cancel \]$/)
      expect((row ?? '').length).toBeLessThanOrEqual(70)
      await ui.unmount()
    })

    test('at 40 columns a row still keeps to one line, its button whole', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([RUNNING]), {}, 40)
      const all = await lines(ui, 40)
      let rowLines = 0
      for (const line of all) {
        if (/^[●…✓!■] /.test(line)) {
          rowLines++
          expect(line).toMatch(/\[ Cancel \]$/)
        }
        expect(line.length, line).toBeLessThanOrEqual(40)
      }
      expect(rowLines).toBe(1)
      await ui.unmount()
    })
  })

  describe('width bands', () => {
    const LONG_MODEL = task({ id: 'ddd444', worker: 'local', title: 'unit tests', state: 'queued', location: 'here', mode: 'read', queue_model: 'qwen3.6-35b-a3b', started_at: null, elapsed_ms: null, fenced: null })
    const STOPPED = task({ id: 'sss000', title: 'Write the tests', state: 'stopped', stop_reason: 'time-limit', elapsed_ms: 3 * 3600000, reported_at: 5 })

    test('docked rows draw the short state label, so a long model name does not eat the title', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([RUNNING, LONG_MODEL, CONFLICT, STOPPED, DONE_READ]), {}, 89)
      const all = await lines(ui, 89)
      expect(lineWith(all, /^… local\s+unit tests\s+queued\s+here\s+\[ Cancel \]$/)).toBeDefined()
      expect(lineWith(all, /^! local\s+fix auth test\s+conflict\s+copy\s+8m00s\s+\[ Discard \]$/)).toBeDefined()
      expect(lineWith(all, /^■ codex\s+Write the tests\s+stopped\s+copy\s+3h00m\s+\[ Clear \]$/)).toBeDefined()
      expect(lineWith(all, /^✓ agy\s+review CSS\s+done · read only\s+here\s+1m01s\s+\[ Clear \]$/)).toBeDefined()
      await ui.unmount()
    })

    test('a docked title is cut at 36 columns whatever the state labels are', async ($, on) => {
      const longTitle = task({ id: 'hhh888', title: 'Rebuild the whole checkout flow with the new payment provider' })
      const { ui } = await mountWith($, on, () => shown([longTitle, CONFLICT]), {}, 89)
      expect(lineWith(await lines(ui, 89), /^● codex/)).toMatch(/^● codex {2}Rebuild the whole checkout flow wit… {2}running/)
      await ui.unmount()
    })

    test('a wide pane draws the long labels and titles up to 48 columns', async ($, on) => {
      const longTitle = task({ id: 'hhh888', title: 'Rebuild the whole checkout flow with the new payment provider' })
      const { ui } = await mountWith($, on, () => shown([longTitle, LONG_MODEL, CONFLICT, STOPPED]), {}, 140)
      const all = await lines(ui, 140)
      expect(lineWith(all, /^● codex {2}Rebuild the whole checkout flow with the new pa… {2}running/)).toBeDefined()
      expect(lineWith(all, /queued · waits for qwen3\.6-35b-a3b\s+here/)).toBeDefined()
      expect(lineWith(all, /conflict · src\/auth\.ts\s+copy/)).toBeDefined()
      expect(lineWith(all, /stopped · time-limit\s+copy/)).toBeDefined()
      await ui.unmount()
    })

    const BANDS: { columns: number; row: RegExp }[] = [
      { columns: 59, row: /^! local {2}fix auth test {2,}\[ Discard \]$/ },
      { columns: 60, row: /^! local\s+fix auth test\s+conflict\s+copy\s+8m00s\s+\[ Discard \]$/ },
      { columns: 99, row: /^! local\s+fix auth test\s+conflict\s+copy\s+8m00s\s+\[ Discard \]$/ },
      { columns: 100, row: /^! local\s+fix auth test\s+conflict · src\/auth\.ts\s+copy\s+8m00s\s+\[ Discard \]$/ },
    ]
    for (const band of BANDS) {
      test(`the bands change at 60 and 100: ${band.columns} columns`, async ($, on) => {
        const { ui } = await mountWith($, on, () => shown([CONFLICT]), {}, band.columns)
        const all = await lines(ui, band.columns)
        expect(lineWith(all, /^! local/)).toMatch(band.row)
        for (const line of all) expect(line.length, line).toBeLessThanOrEqual(band.columns)
        await ui.unmount()
      })
    }

    for (const columns of [44, 59, 60, 70, 89, 100]) {
      test(`a task that ran 9m59s keeps its row inside ${columns} columns`, async ($, on) => {
        const quick = task({ id: 'ab12cd', state: 'done', title: 'Rebuild the whole checkout flow with the new payment provider and more', elapsed_ms: 9 * 60000 + 59000, reported_at: 5 })
        const { ui } = await mountWith($, on, () => shown([quick, RUNNING]), {}, columns)
        const all = await lines(ui, columns)
        for (const line of all) expect(line.length, line).toBeLessThanOrEqual(columns)
        const row = lineWith(all, /^✓ codex/) as string
        if (columns >= 60) expect(row).toMatch(/\s9m59s\s+\[ Discard \]$/)
        await ui.unmount()
      })
    }

    for (const columns of [60, 70, 89, 100]) {
      test(`a task that ran 11 hours keeps its row inside ${columns} columns`, async ($, on) => {
        const long = task({ id: 'ab12cd', state: 'done', title: 'Rebuild the whole checkout flow with the new payment provider and more', elapsed_ms: (11 * 60 + 5) * 60000, reported_at: 5 })
        const { ui } = await mountWith($, on, () => shown([long, RUNNING]), {}, columns)
        const all = await lines(ui, columns)
        for (const line of all) expect(line.length, line).toBeLessThanOrEqual(columns)
        expect(lineWith(all, /^✓ codex/)).toMatch(/\s11h\s+\[ Discard \]$/)
        await ui.unmount()
      })
    }

    for (const columns of [60, 89]) {
      test(`a time that is not a number shows no elapsed, never NaN (${columns} columns)`, async ($, on) => {
        const running = task({ id: 'ab12cd', title: 'Odd start', started_at: 'soon' as unknown as number, elapsed_ms: null })
        const ended = task({ id: 'cd34ef', title: 'Odd end', state: 'done', elapsed_ms: 'long' as unknown as number, reported_at: 5 })
        const { ui } = await mountWith($, on, () => shown([running, ended]), {}, columns)
        const all = await lines(ui, columns)
        for (const line of all) {
          expect(line).not.toMatch(/NaN/)
          expect(line.length, line).toBeLessThanOrEqual(columns)
        }
        expect(lineWith(all, /Odd start/)).toMatch(/running\s+copy\s+\[ Cancel \]$/)
        await ui.unmount()
      })
    }

    test('a busy row does not move the other cells', async ($, on) => {
      let release: (value: unknown) => void = () => {}
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? shown([RUNNING, task({ id: 'ab12cd', title: 'Other', state: 'running' })]) : new Promise(resolve => { release = resolve })), {}, 89)
      const before = lineWith(await lines(ui, 89), /^● codex {2}About page/) as string
      const cancelling = ui.press({ key: 'delegated:cancel:aaa111' })
      await w.clock.settle()
      const during = await lines(ui, 89)
      const busy = lineWith(during, /^● codex {2}About page/) as string
      const other = lineWith(during, /^● codex {2}Other/) as string
      expect(busy).toMatch(/cancel…/)
      expect(busy.indexOf('copy')).toBe(before.indexOf('copy'))
      expect(other.indexOf('copy')).toBe(before.indexOf('copy'))
      expect(busy.length).toBe(before.length)
      release({ cancelling: true })
      await cancelling
      await ui.unmount()
    })

    test('the hint shows when docked or wide and nothing is selected', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH, {}, 89)
      expect(lineWith(await lines(ui, 89), /^press a task for its summary, folder and log$/)).toBeDefined()
      await ui.press({ key: 'delegated:row:aaa111' })
      expect(lineWith(await lines(ui, 89), /press a task/)).toBeUndefined()
      await ui.unmount()
    })

    test('the worker and the title are one press that selects the task', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH, {}, 89)
      const name = await ui.find({ key: 'delegated:row:aaa111' })
      expect(name?.props.plain).toBe(true)
      expect(name?.text).toMatch(/^codex\s+About page\s*$/)
      await ui.press({ key: 'delegated:row:aaa111' })
      expect((await ui.find({ type: 'Text', text: /^About page\s*$/ }))?.props.bold).toBe(true)
      await ui.unmount()
    })

    test('a busy narrow row says so on its second line', async ($, on) => {
      let release: (value: unknown) => void = () => {}
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : new Promise(resolve => { release = resolve })), {}, 50)
      const clearing = ui.press({ key: 'delegated:clear:bbb222' })
      await w.clock.settle()
      expect(lineWith(await lines(ui, 50), /^ {4}clearing… · in a copy · 20m$/)).toBeDefined()
      release({ cleared: 'bbb222' })
      await clearing
      await ui.unmount()
    })

    test('the empty state wraps', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([]), {}, 44)
      const text = await ui.find({ type: 'Text', text: /^No delegated tasks yet/ })
      expect(text?.props.wrap).toBe('wrap')
      await ui.unmount()
    })
  })

  describe('the detail block', () => {
    const SUMMARY = 'The repo is a two-page static site; about.html links back to index.html.'
    const REPORTED = task({
      id: 'ad4749',
      worker: 'local',
      title: 'Summarise repo files',
      state: 'done',
      location: 'here',
      mode: 'read',
      fenced: false,
      fence: 'fenced',
      fence_layer: 'guard',
      reported_at: 5,
      started_at: NOW - 60000,
      elapsed_ms: 48000,
      summary: SUMMARY,
      folder: 'C:/proj',
      log_path: 'C:/Users/me/.claude/consult-delegate/tasks/ad4749/log.jsonl',
      report_path: 'C:/Users/me/.claude/consult-delegate/tasks/ad4749/final.md',
    })

    test('has the summary, two Links, three buttons and one warning line, in that order', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([REPORTED]), {}, 89)
      await ui.press({ key: 'delegated:row:ad4749' })
      const all = await lines(ui, 89)
      const at = all.findIndex(line => line.includes('The repo is a two-page'))
      expect(all[at]).toBe(`    ${SUMMARY}`)
      expect(all[at + 1]).toBe('    folder  C:/proj')
      expect(all[at + 2]).toBe('    log     C:/Users/me/.claude/consult-delegate/tasks/ad4749/log.jsonl')
      expect(all[at + 3]).toBe('    [ Open folder ]  [ Open report ]  [ Show log ]')
      expect(all[at + 4]).toBe('    edits checked')
      await ui.unmount()
    })

    test('narrow, the buttons are short and the paths keep their tail', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([REPORTED]), {}, 44)
      await ui.press({ key: 'delegated:row:ad4749' })
      const all = await lines(ui, 44)
      expect(lineWith(all, /^ {4}\[ Folder \]  \[ Report \]  \[ Log \]$/)).toBeDefined()
      expect(lineWith(all, /^ {4}log {5}…\S*ad4749\/log\.jsonl$/)).toBeDefined()
      const logLink = (await ui.findAll({ type: 'Link' })).find(link => String(link.props.href).endsWith('log.jsonl'))
      expect(String(logLink?.props.label).length).toBeLessThanOrEqual(44 - 4 - 8)
      expect(logLink?.props.href).toBe('file:///C:/Users/me/.claude/consult-delegate/tasks/ad4749/log.jsonl')
      for (const line of all) expect(line.length, line).toBeLessThanOrEqual(44)
      await ui.unmount()
    })

    const TASK_FOLDER = 'C:/Users/me/.claude/consult-delegate/tasks/ad4749'
    const ON_DISK = { dirs: ['C:/proj', TASK_FOLDER], files: { [`${TASK_FOLDER}/final.md`]: '', [`${TASK_FOLDER}/log.jsonl`]: '' } }

    test('Open folder opens the folder, Open report the report, Show log selects the log', async ($, on) => {
      const { w, ui } = await mountWith($, on, () => shown([REPORTED]), ON_DISK, 89)
      await ui.press({ key: 'delegated:row:ad4749' })
      await ui.press({ key: 'delegated:open-folder:ad4749' })
      await ui.press({ key: 'delegated:open-report:ad4749' })
      await ui.press({ key: 'delegated:show-log:ad4749' })
      expect(w.seen.processes).toEqual([
        ['explorer.exe', 'C:/proj'],
        ['explorer.exe', 'C:/Users/me/.claude/consult-delegate/tasks/ad4749/final.md'],
        ['explorer.exe', '/select,C:/Users/me/.claude/consult-delegate/tasks/ad4749/log.jsonl'],
      ])
      await ui.unmount()
    })

    test('a path that is not a local path, or a report that is not text, is refused with a toast', async ($, on) => {
      const odd = task({ ...REPORTED, id: '0a0b0c', folder: '//server/share', report_path: 'C:/Users/me/report.bat', log_path: '/etc/passwd' })
      const { w, ui } = await mountWith($, on, () => shown([odd]), {}, 89)
      await ui.press({ key: 'delegated:row:0a0b0c' })
      await ui.press({ key: 'delegated:open-folder:0a0b0c' })
      await ui.press({ key: 'delegated:open-report:0a0b0c' })
      await ui.press({ key: 'delegated:show-log:0a0b0c' })
      expect(w.seen.processes).toEqual([])
      expect(w.seen.toasts).toEqual([
        'consult: not opening share: not a local path',
        'consult: not opening report.bat: not a local text file',
        'consult: not opening passwd: not a local path',
      ])
      await ui.unmount()
    })

    test('Open folder runs only on a folder that exists: a file, or nothing, is refused', async ($, on) => {
      const aFile = task({ ...REPORTED, folder: 'C:/Users/me/evil.bat' })
      const { w, ui } = await mountWith($, on, () => shown([aFile]), { files: { 'C:/Users/me/evil.bat': '' } }, 89)
      await ui.press({ key: 'delegated:row:ad4749' })
      await ui.press({ key: 'delegated:open-folder:ad4749' })
      expect(w.seen.processes).toEqual([])
      expect(w.seen.toasts).toEqual(['consult: not opening evil.bat: not a folder'])
      await ui.unmount()
    })

    test('Open folder on a path that is not there is refused', async ($, on) => {
      const { w, ui } = await mountWith($, on, () => shown([REPORTED]), {}, 89)
      await ui.press({ key: 'delegated:row:ad4749' })
      await ui.press({ key: 'delegated:open-folder:ad4749' })
      expect(w.seen.processes).toEqual([])
      expect(w.seen.toasts).toEqual(['consult: not opening proj: not a folder'])
      await ui.unmount()
    })

    test('Open report and Show log act only on a file inside the task\'s own folder', async ($, on) => {
      const outside = task({ ...REPORTED, report_path: 'C:/Users/me/notes.md', log_path: 'C:/Users/me/.claude/consult-delegate/tasks/ffffff/log.jsonl' })
      const files = { 'C:/Users/me/notes.md': '', 'C:/Users/me/.claude/consult-delegate/tasks/ffffff/log.jsonl': '' }
      const { w, ui } = await mountWith($, on, () => shown([outside]), { files, dirs: [TASK_FOLDER] }, 89)
      await ui.press({ key: 'delegated:row:ad4749' })
      await ui.press({ key: 'delegated:open-report:ad4749' })
      await ui.press({ key: 'delegated:show-log:ad4749' })
      expect(w.seen.processes).toEqual([])
      expect(w.seen.toasts).toEqual(["consult: not opening notes.md: not in the task's folder", "consult: not opening log.jsonl: not in the task's folder"])
      await ui.unmount()
    })

    test('a file in the task folder that is really a link out of it is refused, and a folder is not a report', async ($, on) => {
      const options = { ...ON_DISK, realPaths: { [`${TASK_FOLDER}/final.md`]: 'C:/Users/me/Documents/secret.md' }, dirs: ['C:/proj', TASK_FOLDER, `${TASK_FOLDER}/log.jsonl`] }
      const { w, ui } = await mountWith($, on, () => shown([REPORTED]), options, 89)
      await ui.press({ key: 'delegated:row:ad4749' })
      await ui.press({ key: 'delegated:open-report:ad4749' })
      await ui.press({ key: 'delegated:show-log:ad4749' })
      expect(w.seen.processes).toEqual([])
      expect(w.seen.toasts).toEqual(["consult: not opening final.md: not in the task's folder", "consult: not opening log.jsonl: not in the task's folder"])
      await ui.unmount()
    })

    test('a task id that is not the store\'s format opens nothing from the task folder', async ($, on) => {
      const odd = task({ ...REPORTED, id: 'zzzzzz' })
      // Without the id check the stat would find a folder for this id that resolves to the real task folder, and the report would open.
      const crafted = 'C:/Users/me/.claude/consult-delegate/tasks/zzzzzz'
      const options = { ...ON_DISK, dirs: [...ON_DISK.dirs, crafted], realPaths: { [crafted]: TASK_FOLDER } }
      const { w, ui } = await mountWith($, on, () => shown([odd]), options, 89)
      await ui.press({ key: 'delegated:row:zzzzzz' })
      await ui.press({ key: 'delegated:open-report:zzzzzz' })
      expect(w.seen.processes).toEqual([])
      expect(w.seen.toasts.length).toBe(1)
      await ui.unmount()
    })

    test('a task with no report draws no Open report; one with nothing to show draws no button row', async ($, on) => {
      const bare = task({ ...REPORTED, id: 'bbb000', report_path: null, folder: null, log_path: null })
      const { ui, show } = await showing($, on, 89)
      await show(shown([task({ ...REPORTED, id: 'ccc000', report_path: null })]))
      await ui.press({ key: 'delegated:row:ccc000' })
      expect(await ui.find({ key: 'delegated:open-report:ccc000' })).toBeUndefined()
      expect(await ui.find({ key: 'delegated:open-folder:ccc000' })).toBeDefined()
      await show(shown([bare]))
      await ui.press({ key: 'delegated:row:bbb000' })
      expect(lineWith(await lines(ui, 89), /\[ Open folder \]|\[ Show log \]/)).toBeUndefined()
      await ui.unmount()
    })

    test('the summary is dim, and takes the problem colour when the task did not go well', async ($, on) => {
      const cases: { state: string; color: unknown }[] = [
        { state: 'done', color: undefined },
        { state: 'merged', color: undefined },
        { state: 'failed', color: 'error' },
        { state: 'stopped', color: 'warning' },
        { state: 'conflict', color: 'warning' },
        { state: 'paused-limit', color: 'warning' },
      ]
      const { ui, show } = await showing($, on, 89)
      for (const one of cases) {
        await show(shown([task({ id: 'sum001', state: one.state, summary: 'Stopped: the time limit of 3 h was reached.' })]))
        await ui.press({ key: 'delegated:row:sum001' })
        const text = await ui.find({ type: 'Text', text: /time limit of 3 h/ })
        expect([one.state, text?.props.color, text?.props.dimColor]).toEqual([one.state, one.color, one.color === undefined])
        await ui.press({ key: 'delegated:row:sum001' })
      }
      await ui.unmount()
    })

    test('a docked row puts what its short label dropped before the summary; a wide one does not', async ($, on) => {
      const conflict = task({ ...CONFLICT, summary: 'Two files clash.' })
      const docked = await mountWith($, on, () => shown([conflict, QUEUED]), {}, 89)
      await docked.ui.press({ key: 'delegated:row:ccc333' })
      expect(lineWith(await lines(docked.ui, 89), /^ {4}conflict in src\/auth\.ts · Two files clash\.$/)).toBeDefined()
      await docked.ui.press({ key: 'delegated:row:ccc333' })
      await docked.ui.press({ key: 'delegated:row:ddd444' })
      expect(lineWith(await lines(docked.ui, 89), /^ {4}waits for qwen3\.6$/)).toBeDefined()
      await docked.ui.unmount()
    })

    test('a wide row already shows the long label, so its summary stands alone', async ($, on) => {
      const conflict = task({ ...CONFLICT, summary: 'Two files clash.' })
      const wide = await mountWith($, on, () => shown([conflict]), {}, 120)
      await wide.ui.press({ key: 'delegated:row:ccc333' })
      expect(lineWith(await lines(wide.ui, 120), /^ {4}Two files clash\.$/)).toBeDefined()
      await wide.ui.unmount()
    })
  })

  describe('Stop all asks first', () => {
    const TWO = shown([RUNNING, QUEUED, MERGED])

    const QUESTIONS: { name: string; answer: DelegateShow; question: RegExp }[] = [
      { name: 'this project only', answer: TWO, question: /^Stop 2 tasks\?\s+\[ Yes \]\s+\[ No \]$/ },
      { name: 'other projects have tasks going', answer: shown([RUNNING, QUEUED], { elsewhere: [{ project: 'C:/other/site', finished: 0, running: 2 }] }), question: /^Stop 4 tasks in all projects\?\s+\[ Yes \]\s+\[ No \]$/ },
      { name: 'one task', answer: shown([RUNNING]), question: /^Stop 1 task\?\s+\[ Yes \]/ },
      { name: 'other projects only have finished tasks', answer: shown([RUNNING], { elsewhere: [{ project: 'C:/other/site', finished: 3, running: 0 }] }), question: /^Stop 1 task\?\s+\[ Yes \]/ },
    ]
    for (const one of QUESTIONS) {
      test(`the question: ${one.name}`, async ($, on) => {
        const { ui } = await mountWith($, on, () => one.answer, {}, 89)
        await ui.press({ key: 'delegated:stop-all' })
        expect(lineWith(await lines(ui, 89), /^Stop /)).toMatch(one.question)
        await ui.unmount()
      })
    }

    test('the question stands in place of the action row, and nothing is sent until Yes', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? TWO : { stopped: ['a', 'b'], failed: [] }), {}, 89)
      await ui.press({ key: 'delegated:stop-all' })
      expect(await ui.find({ key: 'delegated:stop-all' })).toBeUndefined()
      expect(await ui.find({ key: 'delegated:refresh' })).toBeUndefined()
      expect(commandsRun(w)).toEqual(['show'])
      await ui.press({ key: 'delegated:stop-all-yes' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show', 'stop-all', 'show'])
      expect(await ui.find({ key: 'delegated:stop-all-yes' })).toBeUndefined()
      await ui.unmount()
    })

    test('No sends nothing and brings the buttons back', async ($, on) => {
      const { w, ui } = await mountWith($, on, () => TWO, {}, 89)
      await ui.press({ key: 'delegated:stop-all' })
      await ui.press({ key: 'delegated:stop-all-no' })
      expect(commandsRun(w)).toEqual(['show'])
      expect(await ui.find({ key: 'delegated:stop-all' })).toBeDefined()
      expect(await ui.find({ key: 'delegated:refresh' })).toBeDefined()
      await ui.unmount()
    })

    test('fits at 40 columns, its question cut before its buttons', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([RUNNING, QUEUED], { elsewhere: [{ project: 'C:/other/site', finished: 0, running: 2 }] }), {}, 40)
      await ui.press({ key: 'delegated:stop-all' })
      const all = await lines(ui, 40)
      expect(lineWith(all, /\[ Yes \]\s+\[ No \]$/)).toBeDefined()
      for (const line of all) expect(line.length, line).toBeLessThanOrEqual(40)
      await ui.unmount()
    })

    describe('is closed by a read that finds something changed', () => {
      async function askedWith($: Engine, on: On, first: DelegateShow) {
        const current = { shown: first }
        const opened = await mountWith($, on, () => current.shown, {}, 89)
        await opened.ui.press({ key: 'delegated:stop-all' })
        // The question hides Refresh: the tab itself reads again.
        const reread = async (next: DelegateShow) => {
          current.shown = next
          await opened.ui.press({ key: 'tab:delegated' })
          await opened.w.clock.settle()
        }
        return { ...opened, reread }
      }

      test('the number of active tasks changed', async ($, on) => {
        const { w, ui, reread } = await askedWith($, on, TWO)
        await reread(shown([RUNNING, QUEUED, MERGED], { elsewhere: [{ project: 'C:/other/site', finished: 0, running: 1 }] }))
        expect(await ui.find({ key: 'delegated:stop-all-yes' })).toBeUndefined()
        expect(await ui.find({ key: 'delegated:stop-all' })).toBeDefined()
        expect(commandsRun(w).filter(command => command === 'stop-all')).toEqual([])
        await ui.unmount()
      })

      test('the same number, but other tasks', async ($, on) => {
        const { ui, reread } = await askedWith($, on, TWO)
        await reread(shown([RUNNING, task({ id: 'zzz999', title: 'other', state: 'running' }), MERGED]))
        expect(await ui.find({ key: 'delegated:stop-all-yes' })).toBeUndefined()
        await ui.unmount()
      })

      test('and stays when nothing changed', async ($, on) => {
        const { ui, reread } = await askedWith($, on, TWO)
        await reread(shown([RUNNING, QUEUED, MERGED, DONE_READ]))
        expect(await ui.find({ key: 'delegated:stop-all-yes' })).toBeDefined()
        await ui.unmount()
      })

    })

    test('pressing a row drops the question', async ($, on) => {
      const { ui } = await mountWith($, on, () => TWO, {}, 89)
      await ui.press({ key: 'delegated:stop-all' })
      await ui.press({ key: 'delegated:row:bbb222' })
      expect(await ui.find({ key: 'delegated:stop-all-yes' })).toBeUndefined()
      await ui.unmount()
    })
  })

  describe('the on-close line', () => {
    test('keeps "change" apart from the sentence: the separator is in the fixed box with the button', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH, {}, 44)
      const change = await ui.find({ key: 'delegated:on-close-change' })
      expect(change).toBeDefined()
      const boxes = await ui.findAll({ type: 'Box' })
      let holder: { children?: unknown[]; props: Record<string, unknown> } | undefined
      for (const box of boxes) {
        for (const child of (box.children ?? []) as { props?: Record<string, unknown> }[]) {
          if (child.props?.key === 'delegated:on-close-change') holder = box
        }
      }
      expect(holder?.props.flexShrink).toBe(0)
      const texts: unknown[] = []
      for (const child of (holder?.children ?? []) as { type: string; children?: unknown[] }[]) {
        if (child.type === 'Text') texts.push(...(child.children ?? []))
      }
      expect(texts).toEqual([' · '])
      expect(lineWith(await lines(ui, 44), /^On close: tasks stop · change$/)).toBeDefined()
      await ui.unmount()
    })

    test('fits at 40 columns, in both words', async ($, on) => {
      const keeping = shown([RUNNING], { settings: { ...SETTINGS, on_close: 'keep' } })
      const { ui } = await mountWith($, on, () => keeping, {}, 40)
      expect(lineWith(await lines(ui, 40), /^On close: tasks keep running · change$/)).toBeDefined()
      await ui.unmount()
    })
  })

  describe('renders', () => {
    // The pictures the design pass is judged by; set PRINT_RENDERS to see them.
    const PRINT_RENDERS = false
    for (const columns of [44, 89]) {
    test(`${columns} columns, one row selected`, async ($, on) => {
      const REPORTED = task({
        id: 'ad4749', worker: 'local', title: 'Summarise repo files', state: 'done', location: 'here', mode: 'read', fenced: false, reported_at: 5,
        started_at: NOW - 60000, elapsed_ms: 48000, summary: 'The repo is a two-page static site; about.html links back to index.html.',
        folder: 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-so/delegate-live', log_path: 'C:/Users/user/.claude/consult-delegate/tasks/ad4749/log.jsonl',
        report_path: 'C:/Users/user/.claude/consult-delegate/tasks/ad4749/final.md',
      })
      const rows = [
        task({ id: 'r00001', worker: 'local', title: 'Write the README summary of the whole repo', started_at: NOW - 2000, elapsed_ms: 2000 }),
        task({ id: 'r00002', title: 'Write the tests', state: 'cancelled', elapsed_ms: 6000, reported_at: 5 }),
        REPORTED,
        task({ id: 'r00004', title: 'Add about.html page', state: 'merged', merged_files: 2, elapsed_ms: 60000, reported_at: 5 }),
      ]
      const { ui } = await mountWith($, on, () => shown(rows), {}, columns)
      await ui.press({ key: 'delegated:row:ad4749' })
      if (columns === 89) await ui.press({ key: 'delegated:stop-all' })
      const all = await lines(ui, columns)
      if (PRINT_RENDERS) console.log(`---- ${columns} columns ----\n${all.join('\n')}\n----`)
      for (const line of all) expect(line.length, line).toBeLessThanOrEqual(columns)
      await ui.unmount()
    })
    }
  })

  describe('settings', () => {
    test('are folded by default: one summarising line, no field', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH)
      const all = await lines(ui, 100)
      expect(lineWith(all, /^▸ Settings\s+workers edit Auto · table · local at once auto \(1\) · limit 3 h$/)).toBeDefined()
      for (const key of ['workers_edit', 'table:code', 'table:research_review', 'table:private', 'on_close', 'local_at_once', 'time_limit']) {
        expect(await ui.find({ key: `delegated:set:${key}` }), key).toBeUndefined()
      }
      expect(await ui.find({ key: 'delegated:save' })).toBeUndefined()
      await ui.unmount()
    })

    test('open, they show the current values', async ($, on) => {
      const { ui } = await mountWith($, on, () => SKETCH)
      await ui.press({ key: 'delegated:fold' })
      expect((await ui.find({ key: 'delegated:set:workers_edit' }))?.props.value).toBe('auto')
      expect((await ui.find({ key: 'delegated:set:table:code' }))?.props.value).toBe('codex')
      expect((await ui.find({ key: 'delegated:set:table:research_review' }))?.props.value).toBe('agy')
      expect((await ui.find({ key: 'delegated:set:table:private' }))?.props.value).toBe('local')
      expect((await ui.find({ key: 'delegated:set:on_close' }))?.props.value).toBe('stop')
      expect((await ui.find({ key: 'delegated:set:local_at_once' }))?.props.value).toBe('auto')
      expect((await ui.find({ key: 'delegated:set:time_limit' }))?.props.value).toBe('3h')
      const labels: string[] = []
      for (const option of ((await ui.find({ key: 'delegated:set:workers_edit' }))?.props.options ?? []) as { label: string }[]) labels.push(option.label)
      expect(labels).toEqual(['Auto', 'Here', 'In a copy'])
      expect(await ui.find({ key: 'delegated:save' })).toBeDefined()
      await ui.press({ key: 'delegated:fold' })
      expect(await ui.find({ key: 'delegated:save' })).toBeUndefined()
      await ui.unmount()
    })

    test('local at once reads "auto (n)" with the number it comes to now, a plain number as set, and "auto" when unknown', async ($, on) => {
      const { ui, show } = await showing($, on)
      await show(shown([RUNNING], { settings: { ...SETTINGS, local_slots: 2 } }))
      expect(lineWith(await lines(ui, 100), /local at once auto \(2\) · limit/)).toBeDefined()
      await show(shown([RUNNING], { settings: { ...SETTINGS, local_at_once: 3, local_slots: null } }))
      expect(lineWith(await lines(ui, 100), /local at once 3 · limit/)).toBeDefined()
      await show(shown([RUNNING], { settings: { ...SETTINGS, local_slots: null } }))
      expect(lineWith(await lines(ui, 100), /local at once auto · limit/)).toBeDefined()
      await show(shown([RUNNING], { settings: { ...SETTINGS, local_slots: 2 } }))
      await ui.press({ key: 'delegated:fold' })
      expect(lineWith(await lines(ui, 100), /^\s*auto is 2 at once right now$/)).toBeDefined()
      expect((await ui.find({ key: 'delegated:set:local_at_once' }))?.props.value).toBe('auto')
      await ui.unmount()
    })

    test('a table row can be ask: every table choice offers it, and a saved ask is shown', async ($, on) => {
      const asking = shown([RUNNING], { settings: { ...SETTINGS, table: { code: 'ask', research_review: 'ask', private: 'local' } } })
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? asking : { settings: SETTINGS, global_written: true }))
      await ui.press({ key: 'delegated:fold' })
      for (const row of ['code', 'research_review', 'private']) {
        const select = await ui.find({ key: `delegated:set:table:${row}` })
        const values: string[] = []
        for (const option of (select?.props.options ?? []) as { value: string }[]) values.push(option.value)
        expect(values, row).toEqual(['codex', 'agy', 'local', 'ask'])
      }
      expect((await ui.find({ key: 'delegated:set:table:code' }))?.props.value).toBe('ask')
      await ui.select({ key: 'delegated:set:table:private', value: 'ask' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      expect(commandsRun(w)[1]).toBe('save {"table":{"private":"ask"}}')
      await ui.unmount()
    })

    test('research and review that differ read as mixed', async ($, on) => {
      const { ui } = await mountWith($, on, () => shown([RUNNING], { settings: { ...SETTINGS, table: { ...SETTINGS.table, research_review: 'mixed' } } }))
      await ui.press({ key: 'delegated:fold' })
      const select = await ui.find({ key: 'delegated:set:table:research_review' })
      expect(select?.props.value).toBe('mixed')
      const labels: string[] = []
      for (const option of (select?.props.options ?? []) as { label: string }[]) labels.push(option.label)
      expect(labels).toContain('mixed')
      await ui.unmount()
    })

    test('Save sends only what changed, and reads again', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { settings: SETTINGS, global_written: true }))
      await ui.press({ key: 'delegated:fold' })
      await ui.select({ key: 'delegated:set:workers_edit', value: 'copy' })
      await ui.select({ key: 'delegated:set:table:research_review', value: 'codex' })
      await ui.select({ key: 'delegated:set:on_close', value: 'keep' })
      await ui.input({ key: 'delegated:set:time_limit', text: '90', kind: 'change' })
      await ui.input({ key: 'delegated:set:local_at_once', text: '2', kind: 'change' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show', 'save {"workers_edit":"copy","table":{"research_review":"codex"},"local_at_once":2,"on_close":"keep","time_limit_min":90}', 'show'])
      await ui.unmount()
    })

    test('a choice put back to what it was is not sent', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { settings: SETTINGS, global_written: false }))
      await ui.press({ key: 'delegated:fold' })
      await ui.select({ key: 'delegated:set:workers_edit', value: 'here' })
      await ui.select({ key: 'delegated:set:on_close', value: 'keep' })
      await ui.select({ key: 'delegated:set:on_close', value: 'stop' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      expect(commandsRun(w)[1]).toBe('save {"workers_edit":"here"}')
      await ui.unmount()
    })

    test('Save with nothing changed sends nothing', async ($, on) => {
      const { w, ui } = await mountWith($, on, () => SKETCH)
      await ui.press({ key: 'delegated:fold' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      expect(commandsRun(w)).toEqual(['show'])
      await ui.unmount()
    })

    test('keep_backup goes only on a save after one of this session that wrote the global file', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { settings: SETTINGS, global_written: true }))
      await ui.press({ key: 'delegated:fold' })
      await ui.select({ key: 'delegated:set:on_close', value: 'keep' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      await ui.select({ key: 'delegated:set:on_close', value: 'keep' })
      await ui.input({ key: 'delegated:set:time_limit', text: '2h', kind: 'change' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      const saves: string[] = []
      for (const command of commandsRun(w)) {
        if (command.startsWith('save ')) saves.push(command)
      }
      expect(saves).toEqual(['save {"on_close":"keep"}', 'save {"on_close":"keep","time_limit_min":120,"keep_backup":true}'])
      await ui.unmount()
    })

    test('a save that wrote only the project file does not start keeping the backup', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { settings: SETTINGS, global_written: false }))
      await ui.press({ key: 'delegated:fold' })
      await ui.select({ key: 'delegated:set:workers_edit', value: 'copy' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      await ui.select({ key: 'delegated:set:on_close', value: 'keep' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      const saves: string[] = []
      for (const command of commandsRun(w)) {
        if (command.startsWith('save ')) saves.push(command)
      }
      expect(saves).toEqual(['save {"workers_edit":"copy"}', 'save {"on_close":"keep"}'])
      await ui.unmount()
    })

    test('a refused save shows the error inline and keeps the edits', async ($, on) => {
      const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { error: 'delegate.time_limit_min must be a whole number of minutes from 10 to 1440' }))
      await ui.press({ key: 'delegated:fold' })
      await ui.input({ key: 'delegated:set:time_limit', text: '5', kind: 'change' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      expect((await ui.find({ type: 'Text', text: /must be a whole number of minutes from 10 to 1440/ }))?.props.color).toBe('error')
      expect((await ui.find({ key: 'delegated:set:time_limit' }))?.props.value).toBe('5')
      expect(commandsRun(w)).toEqual(['show', 'save {"time_limit_min":5}'])
      await ui.unmount()
    })

    test('text that is not a time limit or a slot count is said so, and nothing is sent', async ($, on) => {
      const { w, ui } = await mountWith($, on, () => SKETCH)
      await ui.press({ key: 'delegated:fold' })
      await ui.input({ key: 'delegated:set:time_limit', text: 'soon', kind: 'change' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      expect(await ui.find({ type: 'Text', text: /Time limit: type minutes or hours/ })).toBeDefined()
      await ui.input({ key: 'delegated:set:time_limit', text: '3h', kind: 'change' })
      await ui.input({ key: 'delegated:set:local_at_once', text: 'lots', kind: 'change' })
      await ui.press({ key: 'delegated:save' })
      await w.clock.settle()
      expect(await ui.find({ type: 'Text', text: /Local at once: type auto or a number/ })).toBeDefined()
      expect(commandsRun(w)).toEqual(['show'])
      await ui.unmount()
    })

    describe('fences', () => {
      const lifted = (fence: Partial<DelegateShow['settings']['fence']>) => shown([RUNNING], { settings: { ...SETTINGS, fence: { ...SETTINGS.fence, ...fence } } })
      const savesOf = (w: World): string[] => commandsRun(w).filter(command => command.startsWith('save '))

      // The test painter cuts a long line at the width, mid-word; the real one wraps at words. Compare without spaces.
      const squash = (text: string) => text.replace(/\s+/g, '')
      const withCheck = (check: 'sandbox' | 'guard' | 'unchecked') => shown([RUNNING], { settings: { ...SETTINGS, local_fence_check: check } })
      const AGY_NOTE = 'enforced by agy (trusted folder: this project only)'
      const LOCAL_NOTES = {
        sandbox: "enforced by Codex's sandbox",
        guard: 'checked by consult: file edits only, commands not',
        unchecked: 'checked on the next task',
      } as const

      for (const columns of [89, 44]) {
        test(`tab: agy note (${columns} columns)`, async ($, on) => {
          const { ui } = await mountWith($, on, () => SKETCH, {}, columns)
          await ui.press({ key: 'delegated:fold' })
          const all = await lines(ui, columns)
          expect(lineWith(all, /Fences \(this project\)/)).toBeDefined()
          expect(squash(all.join(' '))).toContain(squash(AGY_NOTE))
          expect(lineWith(all, /asked only|not enforced/)).toBeUndefined()
          for (const line of all) expect(line.length, line).toBeLessThanOrEqual(columns)
          await ui.unmount()
        })

        for (const check of ['sandbox', 'guard', 'unchecked'] as const) {
          test(`tab: local note ${check} (${columns} columns)`, async ($, on) => {
            const { ui } = await mountWith($, on, () => withCheck(check), {}, columns)
            await ui.press({ key: 'delegated:fold' })
            const all = await lines(ui, columns)
            expect(squash(all.join(' '))).toContain(squash(LOCAL_NOTES[check]))
            // Codex's note is there too, so the sandbox note shows twice; the other two only once, and not together.
            const joined = squash(all.join(' '))
            expect(joined.split(squash("enforced by Codex's sandbox")).length - 1).toBe(check === 'sandbox' ? 2 : 1)
            for (const other of ['guard', 'unchecked'] as const) {
              if (other !== check) expect(joined).not.toContain(squash(LOCAL_NOTES[other]))
            }
            for (const line of all) expect(line.length, line).toBeLessThanOrEqual(columns)
            await ui.unmount()
          })
        }
      }

      test('the fences show for this project, fenced for every worker', async ($, on) => {
        const { ui } = await mountWith($, on, () => SKETCH)
        await ui.press({ key: 'delegated:fold' })
        expect((await ui.find({ key: 'delegated:set:fence:codex' }))?.props.value).toBe('fenced')
        expect((await ui.find({ key: 'delegated:set:fence:agy' }))?.props.value).toBe('fenced')
        expect((await ui.find({ key: 'delegated:set:fence:local' }))?.props.value).toBe('fenced')
        await ui.unmount()
      })

      test('tab: agy and local options read fenced / anywhere', async ($, on) => {
        const { ui } = await mountWith($, on, () => SKETCH)
        await ui.press({ key: 'delegated:fold' })
        for (const worker of ['agy', 'local']) {
          const options = (await ui.find({ key: `delegated:set:fence:${worker}` }))?.props.options as { value: string; label: string }[]
          expect(options).toEqual([
            { value: 'fenced', label: 'fenced' },
            { value: 'none', label: 'anywhere' },
          ])
        }
        await ui.unmount()
      })

      test('tab: an old atom with agy soft draws as fenced, and saving another setting leaves it out', async ($, on) => {
        const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? lifted({ agy: 'soft' as never, local: 'soft' as never }) : { settings: SETTINGS, global_written: false }))
        await ui.press({ key: 'delegated:fold' })
        expect((await ui.find({ key: 'delegated:set:fence:agy' }))?.props.value).toBe('fenced')
        expect((await ui.find({ key: 'delegated:set:fence:local' }))?.props.value).toBe('fenced')
        expect(lineWith(await lines(ui, 100), /anywhere|stay in folder/)).toBeUndefined()
        await ui.select({ key: 'delegated:set:fence:codex', value: 'full' })
        await ui.press({ key: 'delegated:save' })
        await w.clock.settle()
        expect(savesOf(w)).toEqual(['save {"fence":{"codex":"full"}}'])
        await ui.unmount()
      })

      test('fenceNote: guard row says edits checked', () => {
        const guardRow = (more: Partial<DelegateTaskRow>) => task({ id: 'n00001', worker: 'local', fence: 'fenced', fence_layer: 'guard', ...more })
        expect(fenceNote(guardRow({}))).toBe('edits checked')
        expect(fenceNote(guardRow({ fence_layer: 'sandbox' }))).toBeNull()
        expect(fenceNote(guardRow({ worker: 'agy', fence_layer: 'agy' }))).toBeNull()
        expect(fenceNote(guardRow({ fence: 'none', fence_layer: null }))).toBe('anywhere')
        expect(fenceNote(guardRow({ worker: 'codex', fence: 'full', fence_layer: null }))).toBe('full access')
        expect(fenceNote(guardRow({ worker: 'codex', fence: 'fenced', fence_layer: null }))).toBeNull()
      })

      test('fenceNote: soft row has no note', () => {
        expect(fenceNote(task({ id: 'n00002', worker: 'local', fence: 'soft', fenced: false }))).toBeNull()
        expect(fenceNote(task({ id: 'n00003', worker: 'agy', fence: 'soft', fenced: false }))).toBeNull()
        expect(fenceNote(task({ id: 'n00004', worker: 'agy', fence: null, fenced: false }))).toBeNull()
      })

      test("lifting Codex's fence warns before saving", async ($, on) => {
        const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? SKETCH : { settings: SETTINGS, global_written: false }))
        await ui.press({ key: 'delegated:fold' })
        expect(lineWith(await lines(ui, 100), /Full access:/)).toBeUndefined()
        await ui.select({ key: 'delegated:set:fence:codex', value: 'full' })
        const warning = await ui.find({ type: 'Text', text: /Full access: Codex can read, change or delete/ })
        expect(warning?.props.color).toBe('warning')
        await ui.press({ key: 'delegated:save' })
        await w.clock.settle()
        expect(savesOf(w)).toEqual(['save {"fence":{"codex":"full"}}'])
        await ui.unmount()
      })

      const AGY_LIFT =
        "Anywhere: agy may change files in every folder your agy settings trust (today: your home folder), without asking. Changes outside the project don't go through the copy and can't be undone."
      const LOCAL_LIFT =
        "Anywhere: the local model may change or delete any file you can and run any command, without asking. Changes outside the project don't go through the copy and can't be undone."

      test('tab: lifting local shows the local warning', async ($, on) => {
        const { ui } = await mountWith($, on, () => SKETCH)
        await ui.press({ key: 'delegated:fold' })
        await ui.select({ key: 'delegated:set:fence:local', value: 'none' })
        expect((await ui.find({ type: 'Text', text: /^Anywhere: the local model may change or delete any file you can/ }))?.props.color).toBe('warning')
        expect(await ui.find({ type: 'Text', text: /^Anywhere: agy may change files/ })).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: /Full access: Codex can read/ })).toBeUndefined()
        expect(squash((await lines(ui, 100)).join(' '))).toContain(squash(LOCAL_LIFT))
        await ui.unmount()
      })

      test('tab: lifting agy shows the agy warning', async ($, on) => {
        const { ui } = await mountWith($, on, () => SKETCH)
        await ui.press({ key: 'delegated:fold' })
        await ui.select({ key: 'delegated:set:fence:agy', value: 'none' })
        expect(await ui.find({ type: 'Text', text: /^Anywhere: agy may change files/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^Anywhere: the local model/ })).toBeUndefined()
        expect(squash((await lines(ui, 100)).join(' '))).toContain(squash(AGY_LIFT))
        await ui.unmount()
      })

      test('lifting agy and Local gives both lines, and Codex too gives all three', async ($, on) => {
        const { ui } = await mountWith($, on, () => SKETCH)
        await ui.press({ key: 'delegated:fold' })
        await ui.select({ key: 'delegated:set:fence:agy', value: 'none' })
        await ui.select({ key: 'delegated:set:fence:local', value: 'none' })
        expect(await ui.find({ type: 'Text', text: /^Anywhere: agy may change files/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^Anywhere: the local model/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Full access: Codex can read/ })).toBeUndefined()
        await ui.select({ key: 'delegated:set:fence:codex', value: 'full' })
        expect(await ui.find({ type: 'Text', text: /Full access: Codex can read/ })).toBeDefined()
        await ui.unmount()
      })

      test('a lift put back before Save shows no warning and nothing to save', async ($, on) => {
        const { w, ui } = await mountWith($, on, () => SKETCH)
        await ui.press({ key: 'delegated:fold' })
        await ui.select({ key: 'delegated:set:fence:codex', value: 'full' })
        await ui.select({ key: 'delegated:set:fence:codex', value: 'fenced' })
        expect(lineWith(await lines(ui, 100), /Full access:|Anywhere:/)).toBeUndefined()
        expect((await ui.find({ key: 'delegated:save' }))?.props.dimColor).toBe(true)
        await ui.press({ key: 'delegated:save' })
        await w.clock.settle()
        expect(savesOf(w)).toEqual([])
        await ui.unmount()
      })

      test("saving only agy's fence sends only agy", async ($, on) => {
        const { w, ui } = await mountWith($, on, args => (args[0] === 'show' ? lifted({ codex: 'full' }) : { settings: SETTINGS, global_written: false }))
        await ui.press({ key: 'delegated:fold' })
        expect((await ui.find({ key: 'delegated:set:fence:codex' }))?.props.value).toBe('full')
        await ui.select({ key: 'delegated:set:fence:agy', value: 'none' })
        await ui.press({ key: 'delegated:save' })
        await w.clock.settle()
        expect(savesOf(w)).toEqual(['save {"fence":{"agy":"none"}}'])
        await ui.unmount()
      })

      test('the folded line shows a lifted fence, first', async ($, on) => {
        const { ui, show } = await showing($, on, 120)
        await show(lifted({ codex: 'full' }))
        expect(lineWith(await lines(ui, 120), /codex full access/)).toBeDefined()
        await show(lifted({ agy: 'none', local: 'none' }))
        expect(lineWith(await lines(ui, 120), /agy anywhere · local anywhere/)).toBeDefined()
        await show(lifted({}))
        expect(lineWith(await lines(ui, 120), /full access|anywhere/)).toBeUndefined()
        await ui.unmount()
      })

      test('the lifted marker survives at 89 columns, where the rest of the line is cut', async ($, on) => {
        const { ui, show } = await showing($, on, 89)
        await show(lifted({ codex: 'full' }))
        expect(lineWith(await lines(ui, 89), /codex full access/)).toBeDefined()
        await show(lifted({ codex: 'full', agy: 'none', local: 'none' }))
        const all = (await lines(ui, 89)).join(' ')
        expect(all).toMatch(/codex full access/)
        expect(all).toMatch(/agy +anywhere/)
        expect(all).toMatch(/local +anywhere/)
        await ui.unmount()
      })

      test('the lifted marker survives at 44 columns, where the rest of the line is cut', async ($, on) => {
        const { ui, show } = await showing($, on, 44)
        await show(lifted({ codex: 'full' }))
        expect(lineWith(await lines(ui, 44), /codex full access/)).toBeDefined()
        await show(lifted({ codex: 'full', agy: 'none', local: 'none' }))
        const all = (await lines(ui, 44)).join(' ')
        expect(all).toMatch(/codex full access/)
        expect(all).toMatch(/agy +anywhere/)
        expect(all).toMatch(/local +anywhere/)
        await ui.unmount()
      })

      test('a tab state kept from before fences draws, with every worker fenced', async ($, on) => {
        const old = { ...SKETCH, settings: { ...SETTINGS } } as Record<string, any>
        delete old.settings.fence
        const { ui } = await mountWith($, on, () => old)
        expect(lineWith(await lines(ui, 100), /▸ Settings/)).toBeDefined()
        expect(lineWith(await lines(ui, 100), /full access|anywhere/)).toBeUndefined()
        await ui.press({ key: 'delegated:fold' })
        expect((await ui.find({ key: 'delegated:set:fence:codex' }))?.props.value).toBe('fenced')
        expect((await ui.find({ key: 'delegated:set:fence:agy' }))?.props.value).toBe('fenced')
        expect((await ui.find({ key: 'delegated:set:fence:local' }))?.props.value).toBe('fenced')
        await ui.select({ key: 'delegated:set:fence:codex', value: 'full' })
        expect(await ui.find({ type: 'Text', text: /Full access: Codex can read/ })).toBeDefined()
        // Local's note, with no check in the old atom, waits for the next task.
        expect(squash((await lines(ui, 100)).join(' '))).toContain(squash('checked on the next task'))
        await ui.unmount()
      })

      test("task notes follow the task's fence", async ($, on) => {
        const rows = [
          task({ id: 'f00001', worker: 'codex', title: 'first job', fence: 'full' }),
          task({ id: 'f00002', worker: 'agy', title: 'second job', fence: 'none', fenced: false }),
          task({ id: 'f00003', worker: 'agy', title: 'third job', fence: null, fenced: false }),
          task({ id: 'f00004', worker: 'codex', title: 'fourth job', fence: null }),
          task({ id: 'f00005', worker: 'local', title: 'fifth job', fence: 'soft', fenced: false }),
          task({ id: 'f00006', worker: 'agy', title: 'sixth job', fence: 'fenced', fence_layer: 'agy' }),
        ]
        const { ui } = await mountWith($, on, () => shown(rows))
        await ui.press({ key: 'delegated:row:f00001' })
        expect(lineWith(await lines(ui, 100), /^\s+full access$/)).toBeDefined()
        await ui.press({ key: 'delegated:row:f00002' })
        expect(lineWith(await lines(ui, 100), /^\s+anywhere · can't run commands$/)).toBeDefined()
        await ui.press({ key: 'delegated:row:f00003' })
        expect(lineWith(await lines(ui, 100), /^\s+can't run commands$/)).toBeDefined()
        expect(lineWith(await lines(ui, 100), /not fenced/)).toBeUndefined()
        await ui.press({ key: 'delegated:row:f00004' })
        expect(lineWith(await lines(ui, 100), /fenced|full access|anywhere/)).toBeUndefined()
        await ui.press({ key: 'delegated:row:f00005' })
        expect(lineWith(await lines(ui, 100), /not fenced|anywhere|edits checked/)).toBeUndefined()
        await ui.press({ key: 'delegated:row:f00006' })
        expect(lineWith(await lines(ui, 100), /^\s+can't run commands$/)).toBeDefined()
        await ui.unmount()
      })

      for (const columns of [44, 89]) {
        test(`at ${columns} columns, with the fold open and both warnings shown, no line is wider`, async ($, on) => {
          const { ui } = await mountWith($, on, () => SKETCH, {}, columns)
          await ui.press({ key: 'delegated:fold' })
          await ui.select({ key: 'delegated:set:fence:codex', value: 'full' })
          await ui.select({ key: 'delegated:set:fence:agy', value: 'none' })
          const all = await lines(ui, columns)
          expect(lineWith(all, /Full access/)).toBeDefined()
          for (const line of all) expect(line.length, line).toBeLessThanOrEqual(columns)
          await ui.unmount()
        })
      }
    })

    test('a refresh while the fold is open keeps what was typed', async ($, on) => {
      const { w, ui } = await mountWith($, on, () => SKETCH)
      await ui.press({ key: 'delegated:fold' })
      await ui.input({ key: 'delegated:set:time_limit', text: '45', kind: 'change' })
      await ui.press({ key: 'delegated:refresh' })
      await w.clock.settle()
      expect((await ui.find({ key: 'delegated:set:time_limit' }))?.props.value).toBe('45')
      await ui.unmount()
    })
  })

  describe('refreshing', () => {
    const START = { cwd: PROJECT, surface: 'terminal', isInteractive: true } as const

    async function watching($: Engine, on: On, tab: 'delegated' | 'answers') {
      let runs = 0
      const w = world(on, { store: { 'pane-tab': tab }, delegate: () => { runs++; return SKETCH } })
      beatInstance(w, 'inst-1', w.clock.now())
      setDelegateIndex(w, [delegateRow()])
      await $.session.start(START)
      await w.clock.settle()
      return { w, runsSoFar: () => runs }
    }

    test('the closed tab runs no process, however the index changes', async ($, on) => {
      const { w, runsSoFar } = await watching($, on, 'delegated')
      setDelegateIndex(w, [delegateRow({ state: 'done' })])
      await w.clock.advance(70_000)
      setDelegateIndex(w, [delegateRow({ state: 'merged' })])
      await w.clock.advance(70_000)
      expect(runsSoFar()).toBe(0)
      expect(w.seen.delegateRuns.length).toBe(0)
    })

    test('another tab shown runs none either', async ($, on) => {
      const { w, runsSoFar } = await watching($, on, 'answers')
      await $.command.run({ command: 'consult', ...COMMAND } as never)
      await w.clock.settle()
      setDelegateIndex(w, [delegateRow({ state: 'done' })])
      await w.clock.advance(70_000)
      expect(runsSoFar()).toBe(0)
    })

    test('the open tab reads again when the watcher sees the index change, and not when it did not', async ($, on) => {
      const { w, runsSoFar } = await watching($, on, 'delegated')
      await $.command.run({ command: 'consult', ...COMMAND } as never)
      await w.clock.settle()
      expect(runsSoFar()).toBe(1)
      await w.clock.advance(70_000)
      expect(runsSoFar()).toBe(1)
      setDelegateIndex(w, [delegateRow({ state: 'done' })])
      await w.clock.advance(70_000)
      expect(runsSoFar()).toBe(2)
      await w.clock.advance(70_000)
      expect(runsSoFar()).toBe(2)
    })

    test('an index rewritten with only a new updated_at (a supervisor heartbeat) reads nothing', async ($, on) => {
      const { w, runsSoFar } = await watching($, on, 'delegated')
      await $.command.run({ command: 'consult', ...COMMAND } as never)
      await w.clock.settle()
      expect(runsSoFar()).toBe(1)
      for (let beat = 1; beat <= 3; beat++) {
        w.files[`${DELEGATE_DATA}/index.json`] = JSON.stringify({ updated_at: 1_000_000 + beat * 5000, tasks: [delegateRow()] })
        await w.clock.advance(70_000)
      }
      expect(runsSoFar()).toBe(1)
      w.files[`${DELEGATE_DATA}/index.json`] = JSON.stringify({ updated_at: 2_000_000, tasks: [delegateRow({ state: 'done' })] })
      await w.clock.advance(70_000)
      expect(runsSoFar()).toBe(2)
    })

    test('once the pane is closed the watcher stops reading for it', async ($, on) => {
      const { w, runsSoFar } = await watching($, on, 'delegated')
      await $.command.run({ command: 'consult', ...COMMAND } as never)
      await w.clock.settle()
      await $.command.run({ command: 'consult', ...COMMAND } as never)
      await w.clock.settle()
      expect(w.seen.closed).toEqual(['consult'])
      setDelegateIndex(w, [delegateRow({ state: 'done' })])
      await w.clock.advance(70_000)
      expect(runsSoFar()).toBe(1)
    })
  })

  test('the whole tab keeps to its width, wide and narrow, with the settings open', async ($, on) => {
    const long = task({ id: 'hhh888', title: 'Rebuild the whole checkout flow with the new payment provider' })
    const pictureShown = shown([RUNNING, MERGED, CONFLICT, QUEUED, DONE_READ, long], { elsewhere: [{ project: 'C:/Users/me/source/other-site', finished: 2, running: 0 }] })
    const { ui } = await mountWith($, on, () => pictureShown, {}, 100)
    await ui.press({ key: 'delegated:row:ccc333' })
    const wide = picture(await ui.drawn(), 100)
    await ui.press({ key: 'delegated:fold' })
    const open = picture(await ui.drawn(), 100)
    await ui.redraw(paneProps(44))
    const narrow = picture(await ui.drawn(), 44)
    await ui.unmount()
    // The frame adds two columns to the width it was laid out at.
    for (const line of `${wide}\n${open}`.split('\n')) expect(line.length, line).toBeLessThanOrEqual(102)
    for (const line of narrow.split('\n')) expect(line.length, line).toBeLessThanOrEqual(46)
    for (const button of ['[ Cancel ]', '[ Clear ]', '[ Discard ]']) expect(narrow, button).toContain(button)
  })
})
