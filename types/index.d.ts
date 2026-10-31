// The consult mod's $.state contract: what the band, the pane and the health
// line read. Named in plugin.json as "types".

export type CallStatus = 'running' | 'answered' | 'error' | 'timeout' | 'cancelled'

export type ImageRef = { path: string; width: number | null; height: number | null; bytes: number }

export type CouncilInfo = { winner: string | null; tied: boolean; members: string[] }

export type CallRecord = {
  id: string
  tool: string
  provider: string
  members: string[]
  model: string | null
  effort: string | null
  prompt: string
  startedAt: number
  limitMs: number
  status: CallStatus
  endedAt: number | null
  summary: string
  answer: string
  answerTruncated: boolean
  images: ImageRef[]
  council: CouncilInfo | null
  // When the prompt this call answers was sent: the pane boxes the calls of
  // one prompt together. null before any prompt.
  turnStartedAt: number | null
  // The background task Claude Code moved the call to at 120 s; its result
  // comes later as a task notification. null while it runs in the turn.
  taskId: string | null
}

export type ServiceName = 'codex' | 'agy' | 'local'

export type ServiceHealth = { state: 'checking' | 'ok' | 'broken' | 'absent' | 'unknown'; reason: string | null }

export type Health = { services: Record<ServiceName, ServiceHealth>; showStartLine: boolean }

// The pane's tabs: earlier answers, the local runner's setup, and the delegated tasks.
export type PaneTab = 'answers' | 'local' | 'delegated'

export type PaneView = { tab: PaneTab; expandedId: string | null; sessionShown: number; earlierShown: number }

// The Local models tab: what hooks/scripts/setlocal.js last showed, and the
// person's choices on top of it. The script's answers are local_setup's.
export type LocalRole = 'default' | 'fast' | 'vision' | 'vision_best' | 'big'

export type LocalProbe = { url: string; type: string | null; up: boolean; needs_key: boolean; key_env: string | null; models: string[]; configured: string | null }

export type LocalRow = { role: LocalRole; proposed: string[]; saved: string | null; saved_state: 'none' | 'kept' | 'replaced' | 'gone'; replacement: string | null; reason: string }

// arch, engine and decode_tps: what a llama-swap config writes under the model's `metadata:`;
// measured_tps: the decode speed seen on this machine's own calls, when none is written
export type LocalModel = { id: string; name?: string; description?: string; vision?: boolean | null; loaded?: boolean; arch?: string | null; engine?: string | null; decode_tps?: number | string | null; measured_tps?: number | null }

export type LocalShow = {
  probe: LocalProbe[]
  configured: { type: string; url: string; in_use: boolean }[]
  in_use: string | null
  settings_warnings: string[]
  runner: string | null
  url?: string
  reachable?: boolean
  // what is saved for the runner, running or not
  saved_nicknames?: Record<LocalRole, string | null>
  start?: string | null
  note?: string
  proposal: { rows: LocalRow[]; new_models?: string[]; models?: (string | LocalModel)[]; fit_known?: boolean; note?: string } | null
  other_loaded?: { type: string; url: string; loaded: string[] }[]
}

export type LocalSetupView = {
  status: 'idle' | 'checking' | 'ready' | 'error'
  error: string | null
  shown: LocalShow | null
  // the runner picked in the tab (null: none picked, and none in use)
  runner: string | null
  // per role: a model id or '__none__' (no nickname)
  picks: Record<LocalRole, string>
  fields: { url: string; key_env: string; start: string }
  use: boolean
  // the last read found no address for the runner: the address field shows
  // until the next read, whatever a preview of a typed address answers
  askAddress: boolean
  diff: string[] | null
  previewing: boolean
  // the number of the latest change: a preview answering an older one is dropped
  changeSeq: number
  // a save is running: Save does nothing until it ends
  saving: boolean
  // a save this session already made consult.local.md.bak: later saves keep it
  backedUp: boolean
  savedMessage: string | null
}

// The Delegated tab: what hooks/scripts/delegate.js last showed, and the
// person's edits on top of it. The script's answers are the delegate tools'.
// What Clear does to a task (the server's clearPlan): refused, at once, or only after the person confirms.
export type DelegateClearKind = 'refuse' | 'now' | 'confirm-unread' | 'confirm-in-place' | 'confirm-discard' | 'confirm-conflict'

// One index row, plus what `show` adds for the tab.
export type DelegateTaskRow = {
  id: string
  worker: string
  model: string | null
  title: string
  state: string
  location: 'here' | 'copy'
  mode: 'read' | 'write'
  summary: string | null
  // null until a worker has started
  fenced: boolean | null
  stop_reason: string | null
  queue_model: string | null
  reported_at: number | null
  keep_running: boolean
  // a follow-up that ends again has another end time: a question asked of one run is not for the next
  ended_at: number | null
  started_at: number | null
  elapsed_ms: number | null
  folder: string | null
  log_path: string | null
  // the worker's last message (final.md), once written
  report_path: string | null
  // files a merge applied; the first file a merge left in conflict
  merged_files: number | null
  first_conflict: string | null
  clear_kind: DelegateClearKind
}

export type DelegateLimit = { level: 'ok' | 'warn' | 'full'; note: string }

export type DelegateSettingsShown = {
  workers_edit: 'auto' | 'here' | 'copy'
  table: { code: string; research_review: string; private: string }
  local_at_once: 'auto' | number
  // what auto comes to now (the slots of what the runner holds); null when the setting is a number or unknown
  // (a save's answer leaves it out)
  local_slots?: number | null
  on_close: 'stop' | 'keep'
  time_limit_min: number
}

export type DelegateShow = {
  rows: DelegateTaskRow[]
  // other projects: counts only
  elsewhere: { project: string; finished: number; running: number }[]
  limits: Record<string, DelegateLimit>
  settings: DelegateSettingsShown
  git: { isRepo: boolean; declined: boolean; setupAllowed: boolean }
}

// The settings fold's fields, as typed: only the ones the person changed are here.
export type DelegateEdits = {
  workers_edit?: string
  code?: string
  research_review?: string
  private?: string
  local_at_once?: string
  on_close?: string
  time_limit?: string
}

// A Yes/No question bound to what it was asked about: a task's run (its state and when it ended), or the set
// of active tasks. A read that finds any of them changed closes it.
export type DelegateConfirm =
  | { kind: 'discard' | 'conflict' | 'clear' | 'unread'; id: string; state: string; endedAt: number | null }
  // Stop all: closed when the number of active tasks, or which of this project's they are, changes
  | { kind: 'stop-all'; count: number; ids: string[] }

export type DelegatedView = {
  status: 'idle' | 'checking' | 'ready' | 'error'
  // a refusal of show, or of an action, drawn inline
  error: string | null
  shown: DelegateShow | null
  // the row selected for its details
  selectedId: string | null
  // the question asked of one run of one task (Discard, or Clear of an in-place one)
  confirm: DelegateConfirm | null
  // rows with an action running: the task id (or 'stop-all') to what it is doing
  busy: Record<string, 'cancel' | 'clear' | 'stop-all'>
  isFoldOpen: boolean
  edits: DelegateEdits
  saving: boolean
  // a save of this session wrote the global file: later saves keep its .bak
  globalWritten: boolean
  savedMessage: string | null
  // the number of the latest show: an older answer is dropped
  seq: number
}

export type HistoryEntry = Omit<CallRecord, 'limitMs'> & { sessionId: string; durationMs: number }

// A delegated task of another project that ended, with no live session of its
// own to report it: the Delegated tab says "open a session there to merge".
export type DelegateElsewhere = { id: string; project: string; worker: string; title: string; state: string }

// An owned task as the band shows it: queued or running, or ended while the
// band showed it (until the person's next prompt). startedAt is null while
// it is queued; limitMs is null in an index row from before 0.15.4.
export type BandTask = { id: string; worker: string; model: string | null; state: string; startedAt: number | null; endedAt: number | null; limitMs: number | null }

// What the delegate watcher keeps: the ids of the tasks this session owns (the
// ones it started, and orphans it picked up; oldest first, at most 200), the
// other projects' ended tasks, and the owned tasks the band shows (absent in
// a session's state from before 0.15.4).
export type DelegateWatch = { owned: string[]; elsewhere: DelegateElsewhere[]; earlierSessions: string[]; band?: BandTask[] }

declare module 'claude-code' {
  interface PluginState {
    consult: { calls: CallRecord[]; finished: string[]; tick: number; turn: number | null; health: Health; pane: PaneView; local: LocalSetupView; delegate: DelegateWatch; delegated: DelegatedView }
  }
}
