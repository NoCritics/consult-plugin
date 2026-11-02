import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { DelegateConfirm, DelegateEdits, DelegatedView, DelegateShow, DelegateTaskRow } from '../../types'
import { runPluginScript } from './run-script'
import type { ScriptAnswer } from './run-script'
import { INITIAL_DELEGATED, INITIAL_PANE, PANE_ID } from './state'

// The Delegated tab's work: hooks/scripts/delegate.js (the delegate tools' own
// code) shows the tasks, cancels, clears, stops all and saves the settings.
// Every press runs the script once, then reads the tasks again. The watcher
// (hooks/mod/delegate.ts) calls refreshDelegatedIfShown when the index changed;
// nothing here polls, and a tab that is not shown runs nothing.

const delegatedAtom = atom({ plugin: 'consult', key: 'delegated' } as const, INITIAL_DELEGATED)
const paneAtom = atom({ plugin: 'consult', key: 'pane' } as const, INITIAL_PANE)

export const TABLE_ROWS = ['code', 'research_review', 'private'] as const
const ACTIVE_STATES = ['queued', 'running']

export function isActiveState(state: string): boolean {
  return ACTIVE_STATES.includes(state)
}

const SCRIPT_LIMIT_MS = 10000
// Removing a big copy can take a while, and a kill would leave it half removed.
const CLEAR_LIMIT_MS = 60000

// Runs delegate.js with the project as an argument, from the plugin's folder
// (as setlocal.js is run): a node.exe planted in the project is not what runs.
// The project is the session's root, as the watcher's is: a Bash cd moves the
// cwd, never the project.
async function runDelegate($: EngineInterface, args: string[]): Promise<ScriptAnswer> {
  const limitMs = args[0] === 'clear' ? CLEAR_LIMIT_MS : SCRIPT_LIMIT_MS
  return runPluginScript($, 'delegate.js', 'delegate', () => $.session.root(), args, limitMs)
}

// ---- what a row says and offers ----

export type RowButton = 'cancel' | 'clear' | 'discard'

// The one button a row has: stop it, take it off the list, or throw its work away.
export function buttonFor(row: DelegateTaskRow): RowButton | null {
  if (ACTIVE_STATES.includes(row.state)) return 'cancel'
  // What Clear does comes from the server (clear_kind). A task that worked in place has its
  // edits in the project already, and a read-only task only holds an answer: for those only
  // a record goes, so the button is Clear; a copy's unmerged work is thrown away with Discard.
  if (row.clear_kind === 'now' || row.clear_kind === 'confirm-unread' || row.clear_kind === 'confirm-in-place') return 'clear'
  if (row.clear_kind === 'confirm-discard' || row.clear_kind === 'confirm-conflict') return 'discard'
  return null
}

// What a row's button asks before it sends: Discard throws a copy's work away,
// and Clear of an unmerged in-place task removes only its record; Clear of a
// read-only answer Claude has not read throws the answer away. All send
// clear with discard true once the person says Yes. Any other Clear sends at once.
export function confirmKindFor(row: DelegateTaskRow): 'discard' | 'conflict' | 'clear' | 'unread' | null {
  // A conflict's clean files and markers are in the project already: only the copy and its branch go.
  if (row.clear_kind === 'confirm-conflict') return 'conflict'
  if (row.clear_kind === 'confirm-discard') return 'discard'
  if (row.clear_kind === 'confirm-unread') return 'unread'
  if (row.clear_kind === 'confirm-in-place') return 'clear'
  return null
}

// The long label carries the tail a docked row has no room for (what a queued task
// waits for, the file in conflict, why it stopped); the short one drops it.
export function stateLabel(row: DelegateTaskRow, isLong = true): string {
  if (row.state === 'running') return 'running'
  if (row.state === 'queued') return row.queue_model === null || !isLong ? 'queued' : `queued · waits for ${row.queue_model}`
  if (row.state === 'done') return row.mode === 'read' ? 'done · read only' : 'done'
  if (row.state === 'merged') {
    if (row.merged_files === null) return 'merged'
    return `merged · ${row.merged_files} ${row.merged_files === 1 ? 'file' : 'files'}`
  }
  if (row.state === 'conflict') return row.first_conflict === null || !isLong ? 'conflict' : `conflict · ${row.first_conflict}`
  if (row.state === 'held') return 'held · for review'
  if (row.state === 'paused-limit') return 'paused · limit'
  if (row.state === 'stopped') return row.stop_reason === null || !isLong ? 'stopped' : `stopped · ${row.stop_reason}`
  return row.state
}

// What the tail the short label dropped says, for the detail block of a docked row; '' when nothing was dropped.
export function labelTail(row: DelegateTaskRow): string {
  if (row.state === 'queued' && row.queue_model !== null) return `waits for ${row.queue_model}`
  if (row.state === 'conflict' && row.first_conflict !== null) return `conflict in ${row.first_conflict}`
  if (row.state === 'stopped' && row.stop_reason !== null) return `stopped: ${row.stop_reason}`
  return ''
}

// The state cell while a row's action runs.
export function busyText(doing: 'cancel' | 'clear'): string {
  return doing === 'cancel' ? 'cancelling…' : 'clearing…'
}

export function markOf(row: DelegateTaskRow): { mark: string; color: string } {
  if (row.state === 'running') return { mark: '●', color: 'suggestion' }
  if (row.state === 'queued') return { mark: '…', color: 'inactive' }
  if (row.state === 'done' || row.state === 'merged') return { mark: '✓', color: 'success' }
  if (row.state === 'stopped' || row.state === 'cancelled') return { mark: '■', color: 'inactive' }
  if (row.state === 'failed') return { mark: '!', color: 'error' }
  return { mark: '!', color: 'warning' }
}

// What a row says of the fence it was started under: Codex lifted, agy or Local
// lifted ('anywhere') or only asked ('not fenced'); null when it is fenced in. A
// task from before fences (null) is judged by its worker's default.
export function fenceNote(row: DelegateTaskRow): string | null {
  if (row.worker === 'codex') return row.fence === 'full' ? 'full access' : null
  return row.fence === 'none' ? 'anywhere' : 'not fenced'
}

// The ids of this project's tasks that are running or queued, sorted.
function activeIds(shown: DelegateShow): string[] {
  const ids: string[] = []
  for (const row of shown.rows) {
    if (ACTIVE_STATES.includes(row.state)) ids.push(row.id)
  }
  return ids.sort()
}

// Whether the Stop all question still asks about the tasks that are active now.
function isStopAllCurrent(confirm: DelegateConfirm, shown: DelegateShow): boolean {
  if (confirm.kind !== 'stop-all') return false
  const ids = activeIds(shown)
  if (confirm.count !== activeCount(shown) || confirm.ids.length !== ids.length) return false
  for (let index = 0; index < ids.length; index++) {
    if (confirm.ids[index] !== ids[index]) return false
  }
  return true
}

// 'Stop 3 tasks?', and 'in all projects' only when other projects have tasks going.
export function stopAllQuestion(shown: DelegateShow): string {
  let elsewhere = 0
  for (const other of shown.elsewhere) elsewhere += other.running
  const count = activeCount(shown)
  return `Stop ${count} ${count === 1 ? 'task' : 'tasks'}${elsewhere > 0 ? ' in all projects' : ''}?`
}

// Tasks running or queued, in this project and in the others (stop-all spans projects).
export function activeCount(shown: DelegateShow): number {
  let count = 0
  for (const row of shown.rows) {
    if (ACTIVE_STATES.includes(row.state)) count++
  }
  for (const other of shown.elsewhere) count += other.running
  return count
}

// ---- the settings fold's text ----

// '3h' or '90m': what the Time limit field starts with.
export function timeLimitText(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

// '3 h' or '90 min': the folded summary's.
export function timeLimitSummary(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}

// 'auto (2)' with what auto comes to now, a set number as it is, 'auto' when that is not known.
export function localAtOnceSummary(settings: DelegateShow['settings']): string {
  if (settings.local_at_once !== 'auto') return String(settings.local_at_once)
  const slots = settings.local_slots
  return typeof slots === 'number' ? `auto (${slots})` : 'auto'
}

// Minutes from '90', '90m', '3h' or '1.5h'; null for anything else.
export function parseTimeLimit(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?\s*$/i.exec(text)
  if (match === null) return null
  const amount = Number(match[1])
  const unit = (match[2] ?? 'm').toLowerCase()
  return Math.round(unit.startsWith('h') ? amount * 60 : amount)
}

// 'auto' or a whole number; null for anything else.
export function parseLocalAtOnce(text: string): 'auto' | number | null {
  const trimmed = text.trim().toLowerCase()
  if (trimmed === 'auto') return 'auto'
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  return null
}

export const FENCE_WORKERS = ['codex', 'agy', 'local'] as const
export type FenceWorker = (typeof FENCE_WORKERS)[number]

// The fences of a shown settings object. A `shown` kept from before 0.16.0 (the
// atom survives a plugin update in a live session) has none: it reads as the
// default, every worker fenced.
export function fencesOf(settings: { fence?: Record<FenceWorker, string> }): Record<FenceWorker, string> {
  return settings.fence ?? { codex: 'fenced', agy: 'soft', local: 'soft' }
}

// The fence the fold holds for a worker: the edit, or the shown value.
export function fenceChosen(view: DelegatedView, worker: FenceWorker): string {
  const shownValue: string = view.shown === null ? '' : fencesOf(view.shown.settings)[worker]
  const edits = view.edits
  const edited = worker === 'codex' ? edits.fence_codex : worker === 'agy' ? edits.fence_agy : edits.fence_local
  return edited ?? shownValue
}

const CODEX_LIFT_WARNING =
  "Full access: Codex can read, change or delete any file you can, and run any command, without asking. Changes outside the project don't go through the copy and can't be undone."
const OTHER_LIFT_WARNING =
  'Anywhere: agy and Local are no longer asked to stay in the project folder. They could already reach any file you can; now their brief no longer holds them back.'

// The fences whose edit differs from the shown value, as { worker: value }.
function fenceChangesOf(view: DelegatedView): Record<string, string> {
  const changed: Record<string, string> = {}
  if (view.shown === null) return changed
  for (const worker of FENCE_WORKERS) {
    const chosen = fenceChosen(view, worker)
    if (chosen !== fencesOf(view.shown.settings)[worker]) changed[worker] = chosen
  }
  return changed
}

// What to warn about before Save: a fence edited to a lifted value (full / none).
// An edit put back to the shown value is no change and warns of nothing. Codex's
// sentence, then agy and Local's; null when no lift is waiting.
export function liftWarning(view: DelegatedView): string | null {
  const changed = fenceChangesOf(view)
  const warnings: string[] = []
  if (changed.codex === 'full') warnings.push(CODEX_LIFT_WARNING)
  if (changed.agy === 'none' || changed.local === 'none') warnings.push(OTHER_LIFT_WARNING)
  return warnings.length === 0 ? null : warnings.join('\n')
}

// What a Save sends: only the settings that differ from the shown ones, in the
// script's own shape. `problem` says what typed text could not be read.
export function changesOf(view: DelegatedView): { changes: Record<string, unknown>; problem: string | null } {
  const changes: Record<string, unknown> = {}
  if (view.shown === null) return { changes, problem: null }
  const settings = view.shown.settings
  const edits = view.edits
  if (edits.workers_edit !== undefined && edits.workers_edit !== settings.workers_edit) changes.workers_edit = edits.workers_edit
  const table: Record<string, string> = {}
  for (const row of TABLE_ROWS) {
    const edited = edits[row]
    if (edited === undefined || edited === 'mixed' || edited === settings.table[row]) continue
    table[row] = edited
  }
  if (Object.keys(table).length > 0) changes.table = table
  const fence = fenceChangesOf(view)
  if (Object.keys(fence).length > 0) changes.fence = fence
  if (edits.local_at_once !== undefined) {
    const slots = parseLocalAtOnce(edits.local_at_once)
    if (slots === null) return { changes, problem: 'Local at once: type auto or a number.' }
    if (slots !== settings.local_at_once) changes.local_at_once = slots
  }
  if (edits.on_close !== undefined && edits.on_close !== settings.on_close) changes.on_close = edits.on_close
  if (edits.time_limit !== undefined) {
    const minutes = parseTimeLimit(edits.time_limit)
    if (minutes === null) return { changes, problem: 'Time limit: type minutes or hours, like 90 or 3h.' }
    if (minutes !== settings.time_limit_min) changes.time_limit_min = minutes
  }
  return { changes, problem: null }
}

// ---- reading ----

// Reads the tasks again. An answer to an older read is dropped. `keepError`:
// an action's refusal stays drawn when the read after it succeeds.
export async function refreshDelegated($: EngineInterface, keepError = false): Promise<void> {
  // The number is taken inside the update, so two reads that overlap never share one.
  let seq = 0
  await update($, delegatedAtom, (view): DelegatedView => {
    seq = view.seq + 1
    return { ...view, status: view.shown === null ? 'checking' : view.status, seq }
  })
  const answer = await runDelegate($, ['show'])
  await update($, delegatedAtom, (view): DelegatedView => {
    if (view.seq !== seq) return view
    // A failed read keeps the rows drawn before; the error says they may be old.
    if ('error' in answer) return { ...view, status: view.shown === null ? 'error' : 'ready', error: answer.error }
    const shown = answer.json as unknown as DelegateShow
    let selectedId: string | null = null
    let confirm: DelegateConfirm | null = null
    for (const row of shown.rows) {
      if (row.id === view.selectedId) selectedId = row.id
      if (view.confirm !== null && isAskedAbout(view.confirm, row)) confirm = view.confirm
    }
    if (view.confirm !== null && isStopAllCurrent(view.confirm, shown)) confirm = view.confirm
    return { ...view, status: 'ready', error: keepError ? view.error : null, shown, selectedId, confirm }
  })
}

// Whether a question is still about this very run of this task: the same
// state, the same end time, and a button that still asks the same thing.
export function isAskedAbout(confirm: DelegateConfirm, row: DelegateTaskRow): boolean {
  if (confirm.kind === 'stop-all') return false
  return row.id === confirm.id && row.state === confirm.state && row.ended_at === confirm.endedAt && confirmKindFor(row) === confirm.kind
}

// The tab was opened: read the tasks.
export async function openDelegated($: EngineInterface): Promise<void> {
  await refreshDelegated($)
}

// The watcher saw the index change: read again if, and only if, the pane is
// open on this tab.
export async function refreshDelegatedIfShown($: EngineInterface): Promise<void> {
  if ((await read($, paneAtom)).tab !== 'delegated') return
  let isOpen = false
  for (const pane of await $.ui.panes()) {
    if (pane.id === PANE_ID) isOpen = true
  }
  if (!isOpen) return
  if ((await read($, delegatedAtom)).saving) return
  await refreshDelegated($)
}

// ---- pressing ----

// Runs a command on a row (or 'stop-all'), shows a refusal inline, and reads the
// tasks again. The row's button says what is going on until the read is done,
// and a second press of any button of that row, meanwhile, does nothing.
// null when a press found its row busy.
async function runAndRefresh($: EngineInterface, key: string, doing: 'cancel' | 'clear' | 'stop-all', args: string[]): Promise<ScriptAnswer | null> {
  let isFree = false
  await update($, delegatedAtom, (view): DelegatedView => {
    isFree = view.busy[key] === undefined
    if (!isFree) return view
    return { ...view, busy: { ...view.busy, [key]: doing }, error: null, confirm: null, savedMessage: null }
  })
  if (!isFree) return null
  try {
    const answer = await runDelegate($, args)
    if ('error' in answer) await update($, delegatedAtom, (view): DelegatedView => ({ ...view, error: answer.error }))
    await refreshDelegated($, 'error' in answer)
    return answer
  } finally {
    await update($, delegatedAtom, (view): DelegatedView => {
      const busy = { ...view.busy }
      delete busy[key]
      return { ...view, busy }
    })
  }
}

export async function selectRow($: EngineInterface, id: string): Promise<void> {
  await update($, delegatedAtom, (view): DelegatedView => ({ ...view, selectedId: view.selectedId === id ? null : id, confirm: null }))
}

export async function cancelTask($: EngineInterface, id: string): Promise<void> {
  await runAndRefresh($, id, 'cancel', ['cancel', id])
}

// The band's Cancel: a refusal is told in a toast, since the tab that shows
// the errors may not be open.
export async function cancelTaskFromBand($: EngineInterface, id: string): Promise<void> {
  const answer = await runDelegate($, ['cancel', id])
  if ('error' in answer) $.ui.toast(`consult: could not cancel task ${id} (${answer.error.slice(0, 160)})`)
  await refreshDelegatedIfShown($)
}

// The Clear button: a plain clear sends at once; an unmerged in-place task asks first.
export async function pressClear($: EngineInterface, row: DelegateTaskRow): Promise<void> {
  if (confirmKindFor(row) !== null) {
    await askConfirm($, row)
    return
  }
  await runAndRefresh($, row.id, 'clear', ['clear', row.id])
}

// Discard, and Clear of an unmerged in-place task, ask first: nothing is
// sent until the person answers Yes, and the question is of this run only.
export async function askConfirm($: EngineInterface, row: DelegateTaskRow): Promise<void> {
  const kind = confirmKindFor(row)
  if (kind === null) return
  await update($, delegatedAtom, (view): DelegatedView => {
    if (view.busy[row.id] !== undefined) return view
    return { ...view, confirm: { id: row.id, kind, state: row.state, endedAt: row.ended_at } }
  })
}

export async function dropConfirm($: EngineInterface): Promise<void> {
  await update($, delegatedAtom, (view): DelegatedView => ({ ...view, confirm: null }))
}

// Yes: both questions send clear with discard true (the server refuses an
// unmerged task otherwise) - but only if the task is still the run asked about.
export async function confirmYes($: EngineInterface, id: string): Promise<void> {
  const view = await read($, delegatedAtom)
  let row: DelegateTaskRow | null = null
  for (const one of view.shown?.rows ?? []) {
    if (one.id === id) row = one
  }
  if (view.confirm === null || row === null || !isAskedAbout(view.confirm, row)) {
    await dropConfirm($)
    return
  }
  await runAndRefresh($, id, 'clear', ['clear', id, JSON.stringify({ discard: true })])
}

// The Stop all button asks first: nothing is sent until Yes, and the question is of the tasks active now.
export async function askStopAll($: EngineInterface): Promise<void> {
  await update($, delegatedAtom, (view): DelegatedView => {
    if (view.busy['stop-all'] !== undefined || view.shown === null) return view
    const count = activeCount(view.shown)
    if (count === 0) return view
    return { ...view, confirm: { kind: 'stop-all', count, ids: activeIds(view.shown) } }
  })
}

export async function confirmStopAll($: EngineInterface): Promise<void> {
  const view = await read($, delegatedAtom)
  if (view.confirm === null || view.shown === null || !isStopAllCurrent(view.confirm, view.shown)) {
    await dropConfirm($)
    return
  }
  await stopAll($)
}

async function stopAll($: EngineInterface): Promise<void> {
  const answer = await runAndRefresh($, 'stop-all', 'stop-all', ['stop-all'])
  if (answer === null || 'error' in answer) return
  const failed = answer.json.failed
  if (!Array.isArray(failed) || failed.length === 0) return
  const reasons: string[] = []
  for (const one of failed as { id?: string; error?: string }[]) reasons.push(`${one.id ?? '?'}: ${one.error ?? 'failed'}`)
  await update($, delegatedAtom, (view): DelegatedView => ({ ...view, error: `could not stop ${reasons.join('; ')}` }))
}

// ---- the settings fold ----

export async function toggleFold($: EngineInterface): Promise<void> {
  await update($, delegatedAtom, (view): DelegatedView => ({ ...view, isFoldOpen: !view.isFoldOpen }))
}

// "change" on the on-close line: the fold opens and the focus goes to that
// choice. An autoFocus would not do it: the pane already holds the keys, and
// a ring the person has moved stays where it is.
export async function openFoldOnClose($: EngineInterface): Promise<void> {
  await update($, delegatedAtom, (view): DelegatedView => ({ ...view, isFoldOpen: true }))
  // The element is drawn by the next render: the engine waits for it, bounded.
  try {
    await $.ui.focus({ requestId: PANE_ID, key: 'delegated:set:on_close' })
  } catch {
    // the fold is open; the person can move there
  }
}

export async function editSetting($: EngineInterface, field: keyof DelegateEdits, text: string): Promise<void> {
  await update($, delegatedAtom, (view): DelegatedView => ({ ...view, edits: { ...view.edits, [field]: text }, error: null, savedMessage: null }))
}

// Save has something to do, or something to say about what was typed.
export function hasChanges(view: DelegatedView): boolean {
  const { changes, problem } = changesOf(view)
  return Object.keys(changes).length > 0 || problem !== null
}

// Save sends only the changed values. A refusal (or text that is not a
// setting) is drawn inline and the edits stay.
export async function saveSettings($: EngineInterface): Promise<void> {
  const view = await read($, delegatedAtom)
  if (view.saving || view.shown === null) return
  const { changes, problem } = changesOf(view)
  if (problem !== null) {
    await update($, delegatedAtom, (current): DelegatedView => ({ ...current, error: problem, savedMessage: null }))
    return
  }
  if (Object.keys(changes).length === 0) return
  // The first save of a session that wrote the global file made the .bak; the
  // saves after it keep that one.
  const sent = view.globalWritten ? { ...changes, keep_backup: true } : changes
  await update($, delegatedAtom, (current): DelegatedView => ({ ...current, saving: true, error: null, savedMessage: null }))
  const answer = await runDelegate($, ['save', JSON.stringify(sent)])
  if ('error' in answer) {
    await update($, delegatedAtom, (current): DelegatedView => ({ ...current, saving: false, error: answer.error }))
    return
  }
  const isGlobalWritten = answer.json.global_written === true
  await update($, delegatedAtom, (current): DelegatedView => ({
    ...current,
    saving: false,
    edits: {},
    globalWritten: current.globalWritten || isGlobalWritten,
    savedMessage: '✓ Saved',
  }))
  await refreshDelegated($)
}
