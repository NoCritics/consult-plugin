import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { LocalRole, LocalSetupView, LocalShow } from '../../types'
import { runPluginScript } from './run-script'
import type { ScriptAnswer } from './run-script'
import { INITIAL_LOCAL } from './state'

// The Local models tab's work: hooks/scripts/setlocal.js (local_setup's own
// code) shows the runners and a proposal, previews a change as a diff, saves
// it and unloads. Nothing is written but by saveLocal, which the person's
// Save runs after the diff was drawn.

const localAtom = atom({ plugin: 'consult', key: 'local' } as const, INITIAL_LOCAL)

export const LOCAL_RUNNERS = ['llama-swap', 'ollama', 'lmstudio', 'llama-server', 'openai']
export const LOCAL_ROLES: LocalRole[] = ['default', 'fast', 'vision', 'vision_best', 'big']
export const NO_MODEL = '__none__'

const SHOW_LIMIT_MS = 20000
const PREVIEW_LIMIT_MS = 20000
const SAVE_LIMIT_MS = 10000
const UNLOAD_LIMIT_MS = 30000
// A pick or a keystroke waits this long for the next one before the preview runs.
const PREVIEW_DELAY_MS = 300

// Runs setlocal.js with the project as an argument, from the plugin's folder
// (as health.js is run): a node.exe planted in the project is not what runs.
async function runSetlocal($: EngineInterface, args: string[], limitMs: number): Promise<ScriptAnswer> {
  return runPluginScript($, 'setlocal.js', 'setup', () => $.session.cwd(), args, limitMs)
}

// The saved model for each role of the runner shown, or null.
export function savedPicks(shown: LocalShow | null): Record<LocalRole, string | null> {
  const saved: Record<LocalRole, string | null> = { default: null, fast: null, vision: null, vision_best: null, big: null }
  for (const row of shown?.proposal?.rows ?? []) saved[row.role] = row.saved
  return saved
}

// Where a role's picker starts: the saved model (or the other quant that
// replaced it), else the proposal (the first of a tie, marked (tie) in the
// list), else none.
function startingPick(shown: LocalShow, role: LocalRole): string {
  for (const row of shown.proposal?.rows ?? []) {
    if (row.role !== role) continue
    if (row.saved_state === 'kept' && row.saved !== null) return row.saved
    if (row.saved_state === 'replaced' && row.replacement !== null) return row.replacement
    if (row.proposed.length > 0) return row.proposed[0] as string
    return NO_MODEL
  }
  return NO_MODEL
}

export function isVariableName(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)
}

// What a preview or a save sends: only what differs from the file. null when
// nothing does.
export function previewArgs(view: LocalSetupView): Record<string, unknown> | null {
  if (view.runner === null) return null
  const args: Record<string, unknown> = { runner: view.runner }
  let changed = false
  if (view.use && view.shown?.in_use !== view.runner) {
    args.use = true
    changed = true
  }
  for (const field of ['url', 'key_env', 'start'] as const) {
    const typed = view.fields[field].trim()
    // Not a variable's name (a pasted key, say): never sent anywhere.
    if (field === 'key_env' && typed !== '' && !isVariableName(typed)) continue
    if (typed !== '') {
      args[field] = typed
      changed = true
    }
  }
  const saved = savedPicks(view.shown?.runner === view.runner ? view.shown : null)
  const save: Record<string, string | null> = {}
  let saving = false
  for (const role of LOCAL_ROLES) {
    const pick = view.picks[role]
    if (pick === '') continue
    if (pick === NO_MODEL) {
      if (saved[role] !== null) {
        save[role] = null
        saving = true
      }
      continue
    }
    if (pick !== saved[role]) {
      save[role] = pick
      saving = true
    }
  }
  if (saving) {
    args.save = save
    changed = true
  }
  return changed ? args : null
}

// The line Claude reads (and the person sees as a toast) after a save. Claude
// gets it as a user-role row with no frame around it, so it is fixed text:
// nothing the runner supplied (a model name, a nickname value) is repeated.
// Only a runner type from this list is named. The other parameters are kept so
// callers do not change; the text no longer uses them.
const KNOWN_RUNNERS = ['llama-swap', 'ollama', 'lmstudio', 'llama-server', 'openai']

export function noteText(runner: string, _written: Record<string, unknown>, _inUse: string | null): string {
  const named = KNOWN_RUNNERS.includes(runner) ? runner : 'a local runner'
  return `consult: local model settings were changed in the /consult pane (${named}). Call local_status to see the current models.`
}

// Takes in what the script showed: the runner and, where unset, each picker's start.
function withShown(view: LocalSetupView, shown: LocalShow): LocalSetupView {
  const picks = { ...view.picks }
  for (const role of LOCAL_ROLES) {
    const hasPickers = (shown.proposal?.rows ?? []).length > 0 || (shown.proposal?.models ?? []).length > 0
    if (picks[role] === '' && hasPickers) picks[role] = startingPick(shown, role)
  }
  return { ...view, status: 'ready', error: null, shown, runner: shown.runner, picks }
}

// Reads the runners again (the one picked, or the one in use); the pickers
// start over from what is saved.
export async function refreshLocal($: EngineInterface, runner: string | null = null): Promise<void> {
  // A pick's preview still waiting would be of the runner shown before.
  previewTimer?.cancel()
  previewTimer = null
  await update($, localAtom, (view): LocalSetupView => ({
    ...view,
    status: 'checking',
    error: null,
    picks: { ...INITIAL_LOCAL.picks },
    fields: { ...INITIAL_LOCAL.fields },
    diff: null,
    previewing: false,
    savedMessage: null,
    changeSeq: view.changeSeq + 1,
  }))
  const seq = (await read($, localAtom)).changeSeq
  const answer = await runSetlocal($, runner === null ? ['show'] : ['show', runner], SHOW_LIMIT_MS)
  let isLatest = true
  await update($, localAtom, (view): LocalSetupView => {
    // A newer Refresh or runner pick has started: this answer is out of date.
    if (view.changeSeq !== seq) {
      isLatest = false
      return view
    }
    // A failed read leaves no form: what was shown before may no longer hold.
    if ('error' in answer) return { ...view, status: 'error', error: answer.error, shown: null }
    const shown = answer.json as unknown as LocalShow
    const next = withShown(view, shown)
    return { ...next, use: shown.runner !== null && shown.in_use !== shown.runner, askAddress: shown.runner !== null && shown.url === undefined }
  })
  if (isLatest && !('error' in answer)) await previewNow($)
}

// Runs a preview of the change as it is now; an answer to an older change is dropped.
async function previewNow($: EngineInterface): Promise<void> {
  const view = await read($, localAtom)
  if (view.status !== 'ready') return
  const args = previewArgs(view)
  const seq = view.changeSeq
  if (args === null) {
    await update($, localAtom, current => (current.changeSeq === seq ? { ...current, diff: null, previewing: false } : current))
    return
  }
  await update($, localAtom, current => ({ ...current, previewing: true }))
  const answer = await runSetlocal($, ['preview', JSON.stringify(args)], PREVIEW_LIMIT_MS)
  let pickersFilled = false
  await update($, localAtom, current => {
    if (current.changeSeq !== seq) return current
    if ('error' in answer) return { ...current, previewing: false, diff: null, error: answer.error }
    const preview = answer.json.preview as { diff?: string[] } | undefined
    // A preview answers with everything show does: an address or key
    // variable just typed may have made the runner's models readable.
    const next = Array.isArray(answer.json.probe) ? withShown(current, answer.json as unknown as LocalShow) : current
    for (const role of LOCAL_ROLES) {
      if (current.picks[role] === '' && next.picks[role] !== '') pickersFilled = true
    }
    // The args this preview was built from had no picks, so its diff lacks
    // the nicknames Save would now write: it goes, and the preview runs again.
    if (pickersFilled) return { ...next, changeSeq: current.changeSeq + 1, error: null, diff: null }
    return { ...next, previewing: false, error: null, diff: preview?.diff ?? [] }
  })
  // Once only: the picks are filled now, so the second answer cannot fill them again.
  if (pickersFilled) await previewNow($)
}

let previewTimer: { cancel: () => void } | null = null

// A pick, a typed field or the "use" toggle: the view changes now, the
// preview after a short pause, so a run of keystrokes makes one preview.
export async function changeLocal(
  $: EngineInterface,
  change: { role?: LocalRole; model?: string; field?: 'url' | 'key_env' | 'start'; text?: string; use?: boolean },
): Promise<void> {
  await update($, localAtom, view => {
    // The diff drawn was of the view before this change: it goes, and Save
    // waits for the preview of this one.
    const next = { ...view, changeSeq: view.changeSeq + 1, savedMessage: null, diff: null }
    if (change.role !== undefined && change.model !== undefined) next.picks = { ...view.picks, [change.role]: change.model }
    if (change.field !== undefined && change.text !== undefined) next.fields = { ...view.fields, [change.field]: change.text }
    if (change.use !== undefined) next.use = change.use
    return next
  })
  previewTimer?.cancel()
  previewTimer = $.clock.after(PREVIEW_DELAY_MS, () => {
    previewTimer = null
    void previewNow($)
  })
}

// Enter in the address or key variable field: preview at once, since what
// can be read depends on it.
export async function submitLocalField($: EngineInterface, field: 'url' | 'key_env' | 'start', text: string): Promise<void> {
  previewTimer?.cancel()
  previewTimer = null
  await update($, localAtom, view => ({ ...view, changeSeq: view.changeSeq + 1, diff: null, fields: { ...view.fields, [field]: text } }))
  await previewNow($)
}

export function saveBlocked(view: LocalSetupView): boolean {
  return view.diff === null || view.diff.length === 0 || view.previewing || view.saving || view.status !== 'ready'
}

// Save, or Save and unload: the change the diff shows, then a note for
// Claude and a toast for the person, then the runners read again.
export async function saveLocal($: EngineInterface, unload: boolean): Promise<void> {
  const view = await read($, localAtom)
  const args = previewArgs(view)
  if (saveBlocked(view) || args === null || view.runner === null) return
  const runner = view.runner
  await update($, localAtom, current => ({ ...current, saving: true }))
  // Each save is a new setlocal.js: after this session's first, the .bak
  // that holds the file from before it is kept.
  const sent = view.backedUp ? { ...args, keep_backup: true } : args
  const answer = await runSetlocal($, ['save', JSON.stringify(sent)], SAVE_LIMIT_MS)
  if ('error' in answer) {
    await update($, localAtom, current => ({ ...current, saving: false, error: answer.error }))
    return
  }
  await update($, localAtom, current => ({ ...current, saving: false, backedUp: true }))
  const saved = answer.json.saved as { path?: string; written?: Record<string, unknown> } | undefined
  const text = noteText(runner, saved?.written ?? {}, view.shown?.in_use ?? null)
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {
    // the toast still tells the person
  }
  $.ui.toast(text)
  if (unload) {
    for (const other of view.shown?.other_loaded ?? []) {
      const unloaded = await runSetlocal($, ['unload', other.type], UNLOAD_LIMIT_MS)
      if ('error' in unloaded) $.ui.toast(`consult: could not unload ${other.type} (${unloaded.error})`)
    }
  }
  await refreshLocal($, runner)
  await update($, localAtom, current => ({ ...current, savedMessage: 'Saved · old copy kept as consult.local.md.bak' }))
}

// The tab opened: read the runners the first time.
export async function openLocal($: EngineInterface): Promise<void> {
  const view = await read($, localAtom)
  if (view.status === 'idle') await refreshLocal($)
}
