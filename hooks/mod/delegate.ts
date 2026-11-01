import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BandTask, DelegateElsewhere } from '../../types'
import { dataHome, platformOf } from './files'
import { isActiveState, refreshDelegatedIfShown } from './delegated'
import { parseObject, shortToolName, textOf } from './outcome'
import type { Ran } from './outcome'
import { INITIAL_DELEGATE } from './state'

// Watching the tasks consult delegated to Codex, agy and local models: reads
// the data folder's index.json on a clock, wakes Claude (a prompt, and a
// notification) when a task it owns changes to a state that needs it, and
// settles who owns what between sessions.
//
// A task is owned by the session whose delegate / delegate_send result named
// it, whose id the index row names as owner, or that picked it up as an
// orphan: a task of this project whose owner's server heartbeat is gone. The
// ids seen in results live in $.state (this session); claims and the notices
// already sent live in $.store, which sessions share.

const watchAtom = atom({ plugin: 'consult', key: 'delegate' } as const, INITIAL_DELEGATE)
const tickAtom = atom({ plugin: 'consult', key: 'tick' } as const, 0)

const TICK_MS = 5000
// With no task to watch the index is read about once a minute; a tick lands
// a little off its period, so a read this close to the minute is due.
const SLOW_READ_DUE_MS = 59000
const HEARTBEAT_MAX_AGE_MS = 45000
// A claim not stamped again for this long is void: its session is gone. The
// holder stamps it again at least once a minute while the task is unreported.
const CLAIM_FRESH_MS = 600000
const CLAIM_RESTAMP_MS = 60000
const OWNED_CAP = 200
const EARLIER_SESSIONS_CAP = 20
const NOTIFIED_CAP = 500
const NOTIFIED_KEY = 'delegate-notified'
const CLAIM_PREFIX = 'delegate-claim-'
const TITLE_CAP = 80
const NOTIFY_CAP = 200

const WAKE_STATES = ['done', 'held', 'paused-limit', 'conflict', 'failed', 'stopped']
// Ended without anyone there to be told, as the session-start notice lists them, and the
// other projects' tasks the tab mentions: the ones that came to something.
// Not cancelled: a cancel is always the person's or Claude's own doing.
const AWAY_STATES = ['done', 'held', 'paused-limit', 'failed', 'stopped']
const INSTANCE_PATTERN = /^[A-Za-z0-9._-]+$/
// The store's own id format (delegate-store.js): a row or result with any other id is ignored.
const TASK_ID_PATTERN = /^[0-9a-f]{6}$/
// What a prompt may say about a task: the words below, the id and counts, and never text from the
// store. A worker that is not fenced can rewrite its state.json, so a title, a model name, a stop
// reason or a file name it wrote must not reach Claude as if the user had typed it. The tab, drawn
// for the person only, and the toast may show the titles.
const WORKER_WORDS: Record<string, string> = { codex: 'Codex', agy: 'agy', local: 'local' }
const STOP_REASONS = ['time-limit', 'watchdog', 'session-closed', 'supervisor-stopped', 'supervisor-died']

type TaskRow = {
  id: string
  worker: string
  model: string | null
  title: string
  project: string
  state: string
  mode: string | null
  stopReason: string | null
  ownerInstance: string | null
  ownerSession: string | null
  reportedAt: number | null
  queueWaitingLong: boolean
  createdAt: number | null
  // When the task last began waiting (a follow-up requeues it); null in a row from before the field.
  queuedAt: number | null
  startedAt: number | null
  endedAt: number | null
  // The task's own limit, null in a row from before the field.
  timeLimitMs: number | null
  // Files a read-only task changed anyway (agy cannot be fenced); empty when none. Only the count reaches
  // a notice: the names come from a worker that is not fenced, and a notice is submitted with the user's authority.
  editedFiles: string[]
}

// The headline is the toast's (it may name the task by its title); the prompt line is the
// promptHeadline and the ask, which say nothing the store wrote.
type Notice = { key: string; headline: string; promptHeadline: string; ask: string }

// What the watcher knows between ticks. A hot reload cancels the old
// environment's timers and raises session.start again, which arms it anew.
let ticker: { cancel: () => void } | null = null
let isTicking = false
let lastReadAt = 0
// An owned task is queued or running: the index is read every tick.
let isFast = false
// The first read of a session lists what ended while no session was there.
let isSweepPending = false
// The index's rows as the last read found them; null before the first read.
let lastIndexSignature: string | null = null
// A /clear keeps the process, its terminal and its server but gives the session a
// new id, so the ids this process had before are still this person's. $.state is
// not documented to survive a /clear, so they are kept here too (a hot reload
// resets this list, and the $.state copy covers that).
let earlierSessionIds: string[] = []
// The owned ids as a /clear found them, for the same reason.
let ownedBeforeClear: string[] = []
// What cannot change in a session, found on the first tick that needs it: the data folder, whether
// the platform is Windows, and the session's project. Found again when the watch starts.
let dataHomeFound: string | null = null
let isWindowsFound: boolean | null = null
let sessionProjectFound: string | null = null
// projectKey of each project text the index showed; the index repeats a few.
let projectKeys = new Map<string, string>()
// When this session last stamped its claim on a task, by task id, so the store is asked only when a stamp is due.
let claimStamps = new Map<string, number>()
// Each band task's time limit, by task id; 0 when its state.json has none either.
let knownLimits = new Map<string, number>()

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toRow(value: unknown): TaskRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !TASK_ID_PATTERN.test(raw.id)) return null
  if (typeof raw.state !== 'string' || typeof raw.project !== 'string') return null
  if (typeof raw.worker !== 'string' || !Object.hasOwn(WORKER_WORDS, raw.worker)) return null
  return {
    id: raw.id,
    worker: raw.worker,
    model: textOrNull(raw.model),
    title: textOrNull(raw.title) ?? '',
    project: raw.project,
    state: raw.state,
    mode: textOrNull(raw.mode),
    stopReason: textOrNull(raw.stop_reason),
    ownerInstance: textOrNull(raw.owner_instance),
    ownerSession: textOrNull(raw.owner_session),
    reportedAt: typeof raw.reported_at === 'number' ? raw.reported_at : null,
    queueWaitingLong: raw.queue_waiting_long === true,
    createdAt: typeof raw.created_at === 'number' ? raw.created_at : null,
    queuedAt: typeof raw.queued_at === 'number' ? raw.queued_at : null,
    startedAt: typeof raw.started_at === 'number' ? raw.started_at : null,
    endedAt: typeof raw.ended_at === 'number' ? raw.ended_at : null,
    timeLimitMs: typeof raw.time_limit_ms === 'number' && raw.time_limit_ms > 0 ? raw.time_limit_ms : null,
    editedFiles: stringList(raw.read_only_edits),
  }
}

function stringList(value: unknown): string[] {
  const strings: string[] = []
  if (!Array.isArray(value)) return strings
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '') strings.push(entry)
  }
  return strings
}

// What a notice is kept under in the shared list: the task, the state and the
// run it ended (a follow-up ends again at another time), so the same run is
// told once and the next run is told too.
function keyOf(row: TaskRow): string {
  return `${row.id}:${row.state}:${row.endedAt ?? 0}`
}

// Keyed on when the wait began, so a follow-up's own long wait is told again.
function waitingLongKey(row: TaskRow): string {
  return `${row.id}:waiting-long:${row.queuedAt ?? row.createdAt ?? 0}`
}

// A missing, unreadable or odd index is nothing to do. The rows' own text
// comes back with them: a change in it is what the Delegated tab reads again
// for. The file's updated_at is left out, since every supervisor heartbeat
// rewrites the index with a new one and changes no row.
async function readIndex($: EngineInterface, home: string): Promise<{ rows: TaskRow[]; signature: string } | null> {
  try {
    const index = parseObject(await $.fs.read(`${home}/index.json`))
    if (index === null || !Array.isArray(index.tasks)) return null
    const rows: TaskRow[] = []
    for (const value of index.tasks) {
      const row = toRow(value)
      if (row !== null) rows.push(row)
    }
    return { rows, signature: JSON.stringify(index.tasks) }
  } catch {
    return null
  }
}


// The server's own key for a project (delegate-store.js projectKey, which
// resolves the path): slashes one way, no trailing slash, "." and ".." folded
// away, lower-cased where paths ignore case.
function projectKey(path: string, isWindows: boolean): string {
  let key = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1)
  const kept: string[] = []
  for (const part of key.split('/')) {
    if (part === '.') continue
    const last = kept.at(-1)
    if (part !== '..' || last === undefined || last === '..') {
      kept.push(part)
    } else if (last !== '' && !/^[A-Za-z]:$/.test(last)) {
      // a name before it goes; at a root ('' or a drive) it has nothing to go up to
      kept.pop()
    }
  }
  key = kept.join('/')
  return isWindows ? key.toLowerCase() : key
}

// What one pass over the index goes by ($ travels beside it, never in it).
type ScanFacts = {
  home: string
  now: number
  sessionId: string
  isWindows: boolean
  // instance -> whether its heartbeat is fresh, read at most once a tick
  beats: Map<string, boolean>
}

// A server writes { pid, at } to servers/<instance>.json every few seconds.
async function ownerIsLive($: EngineInterface, facts: ScanFacts, row: TaskRow): Promise<boolean> {
  const instance = row.ownerInstance
  if (instance === null || !INSTANCE_PATTERN.test(instance)) return false
  const known = facts.beats.get(instance)
  if (known !== undefined) return known
  let isFresh = false
  try {
    const beat = parseObject(await $.fs.read(`${facts.home}/servers/${instance}.json`))
    isFresh = beat !== null && typeof beat.at === 'number' && facts.now - beat.at <= HEARTBEAT_MAX_AGE_MS
  } catch {
    isFresh = false
  }
  facts.beats.set(instance, isFresh)
  return isFresh
}

// The session a claim names, or null when there is none or it is void.
function claimHolder(value: unknown, now: number): string | null {
  if (value === null || typeof value !== 'object') return null
  const { session, at } = value as { session?: unknown; at?: unknown }
  if (typeof session !== 'string' || typeof at !== 'number') return null
  return now - at > CLAIM_FRESH_MS ? null : session
}

// $.fs has no exclusive create, so a claim is a $.store key: write it, read it
// back, and the session whose id stands there owns the task. Two sessions
// claiming in the same instant can both read their own id back; the notice
// they send is then sent twice, no worse.
async function claim($: EngineInterface, facts: ScanFacts, id: string): Promise<boolean> {
  const key = `${CLAIM_PREFIX}${id}`
  const holder = claimHolder(await $.store.get(key), facts.now)
  if (holder === facts.sessionId) return true
  if (holder !== null) return false
  await $.store.set(key, { session: facts.sessionId, at: facts.now })
  return claimHolder(await $.store.get(key), facts.now) === facts.sessionId
}

// The holder's claim on a task it still has to report is stamped again, so it
// does not go void while this session lives.
async function keepClaim($: EngineInterface, facts: ScanFacts, id: string): Promise<void> {
  const lastStamp = claimStamps.get(id)
  if (lastStamp !== undefined && facts.now - lastStamp < CLAIM_RESTAMP_MS) return
  const key = `${CLAIM_PREFIX}${id}`
  const stored = await $.store.get(key)
  if (claimHolder(stored, facts.now) !== facts.sessionId) {
    claimStamps.delete(id)
    return
  }
  const storedAt = (stored as { at: number }).at
  if (facts.now - storedAt < CLAIM_RESTAMP_MS) {
    claimStamps.set(id, storedAt)
    return
  }
  await $.store.set(key, { session: facts.sessionId, at: facts.now })
  claimStamps.set(id, facts.now)
}

// Claims of tasks that left the index are dropped, so they do not pile up.
async function dropOldClaims($: EngineInterface, rows: TaskRow[]): Promise<void> {
  const present = new Set<string>()
  for (const row of rows) present.add(row.id)
  for (const key of await $.store.keys()) {
    if (key.startsWith(CLAIM_PREFIX) && !present.has(key.slice(CLAIM_PREFIX.length))) await $.store.delete(key)
  }
}

async function loadNotified($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get(NOTIFIED_KEY)
  const keys: string[] = []
  if (Array.isArray(stored)) {
    for (const key of stored) {
      if (typeof key === 'string') keys.push(key)
    }
  }
  return keys
}

// The list is read again just before it is written, so keys another session
// saved meanwhile are kept; the newest NOTIFIED_CAP stay.
async function saveNotified($: EngineInterface, newKeys: string[]): Promise<void> {
  const keys = await loadNotified($)
  for (const key of newKeys) {
    if (!keys.includes(key)) keys.push(key)
  }
  await $.store.set(NOTIFIED_KEY, keys.slice(-NOTIFIED_CAP))
}

function addOwned(owned: string[], ids: string[]): string[] {
  const next = [...owned]
  for (const id of ids) {
    if (!next.includes(id)) next.push(id)
  }
  return next.slice(-OWNED_CAP)
}

function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`
}

function quotedTitle(row: TaskRow): string {
  const title = oneLine(row.title, TITLE_CAP).replace(/"/g, "'")
  return `"${title === '' ? 'untitled' : title}"`
}

// The worker as a prompt says it: the word only.
function workerWord(row: TaskRow): string {
  return WORKER_WORDS[row.worker] ?? 'worker'
}

// The worker as the toast says it: a local task also names its model.
function workerLabel(row: TaskRow): string {
  const model = row.worker === 'local' && row.model !== null ? oneLine(row.model, 40) : ''
  return model === '' ? workerWord(row) : `local (${model})`
}

function stoppedWord(row: TaskRow): string {
  const hasReason = row.stopReason !== null && STOP_REASONS.includes(row.stopReason)
  return hasReason ? `stopped (${row.stopReason})` : 'stopped'
}

// What each ended state says: the outcome as the away list words it, and the headline and
// the ask of its wake notice. The headline is worded for a label and a task, so the toast and
// the prompt each give their own.
type Outcome = {
  away: (row: TaskRow) => string
  headline: (label: string, task: string, row: TaskRow) => string
  ask: (row: TaskRow) => string
}
const FAILED_OUTCOME: Outcome = {
  away: () => 'failed',
  headline: (label, task) => `consult: ${label} failed on ${task}.`,
  ask: () => 'Read the details with delegate_result and tell the user.',
}
const OUTCOME_BY_STATE: Record<string, Outcome> = {
  done: {
    away: () => 'finished',
    headline: (label, task) => `consult: ${label} finished ${task}.`,
    ask: row => (row.mode === 'read' ? 'Read the result with delegate_result.' : 'Review it with delegate_result and merge it with delegate_merge.'),
  },
  held: {
    away: () => 'finished, held for review',
    headline: (label, task) => `consult: ${label} finished ${task}, held for review.`,
    ask: () => 'Read it with delegate_result and ask the user before merging.',
  },
  'paused-limit': {
    away: () => 'stopped at its usage limit',
    headline: (label, task) => `consult: ${label} stopped at its usage limit on ${task}.`,
    ask: () => 'Read what it did with delegate_result, then ask the user: wait for the reset, give the rest to another worker, or finish it with a Claude subagent.',
  },
  conflict: {
    away: () => 'failed',
    headline: (_label, task) => `consult: merging ${task} left conflicts.`,
    ask: () => 'Read the details with delegate_result, resolve them and tell the user.',
  },
  stopped: {
    away: row => stoppedWord(row),
    headline: (label, task, row) => `consult: ${label} ${stoppedWord(row)} on ${task}.`,
    ask: () => 'Read the details with delegate_result and tell the user.',
  },
  failed: FAILED_OUTCOME,
}

function titledTask(row: TaskRow): string {
  return `${quotedTitle(row)} (task ${row.id})`
}

function plainTask(row: TaskRow): string {
  return `task ${row.id}`
}

function wakeNotice(row: TaskRow): Notice {
  const key = keyOf(row)
  if (row.state === 'done' && row.mode === 'read' && row.editedFiles.length > 0) {
    const count = row.editedFiles.length === 1 ? '1 file' : `${row.editedFiles.length} files`
    return {
      key,
      headline: `consult: ${workerLabel(row)} finished ${titledTask(row)}, but it changed ${count} in a read-only task.`,
      promptHeadline: `consult: ${workerWord(row)} finished ${plainTask(row)}, but it changed ${count} in a read-only task.`,
      ask: 'Read the details with delegate_result and tell the user.',
    }
  }
  const outcome = OUTCOME_BY_STATE[row.state] ?? FAILED_OUTCOME
  return {
    key,
    headline: outcome.headline(workerLabel(row), titledTask(row), row),
    promptHeadline: outcome.headline(workerWord(row), plainTask(row), row),
    ask: outcome.ask(row),
  }
}

function waitingLongNotice(row: TaskRow): Notice {
  return {
    key: waitingLongKey(row),
    headline: `consult: local task ${titledTask(row)} has waited over 30 min for the runner.`,
    promptHeadline: `consult: local ${plainTask(row)} has waited over 30 min for the runner.`,
    ask: 'Check it with delegate_status and tell the user.',
  }
}

function awayItem(row: TaskRow): string {
  const outcome = OUTCOME_BY_STATE[row.state] ?? FAILED_OUTCOME
  return `${plainTask(row)}: ${workerWord(row)} ${outcome.away(row)}`
}

function bandTaskOf(row: TaskRow): BandTask {
  return {
    id: row.id,
    worker: row.worker,
    // A worker that is not fenced can rewrite its model: one line, no control characters, at most 40.
    model: row.model === null ? null : oneLine(row.model.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '), 40),
    state: row.state,
    // null for a task that never started, even one that ended in the queue
    startedAt: row.state === 'queued' ? null : row.startedAt,
    endedAt: row.endedAt,
    limitMs: row.timeLimitMs,
  }
}

// The owned tasks the band shows, in the index's order: the queued and running
// ones, and the ones that ended while it showed them, kept until the person's
// next prompt.
function nextBand(shown: BandTask[], seen: BandTask[]): BandTask[] {
  const shownIds = new Set<string>()
  for (const task of shown) shownIds.add(task.id)
  const next: BandTask[] = []
  for (const task of seen) {
    if (isActiveState(task.state) || shownIds.has(task.id)) next.push(task)
  }
  return next
}

// A task's time limit never changes. A consult server older than 0.15.4,
// still running in another session, rewrites the shared index without it, so
// a row without one takes the limit seen before, or else the one in the
// task's own state.json, read once.
async function timeLimitOf($: EngineInterface, home: string, row: TaskRow): Promise<number | null> {
  if (row.timeLimitMs !== null) {
    knownLimits.set(row.id, row.timeLimitMs)
    return row.timeLimitMs
  }
  let known = knownLimits.get(row.id)
  if (known === undefined) {
    known = 0
    try {
      const state = parseObject(await $.fs.read(`${home}/tasks/${row.id}/state.json`))
      if (state !== null && typeof state.time_limit_ms === 'number' && state.time_limit_ms > 0) known = state.time_limit_ms
    } catch {
      // unreadable for now (Windows refuses a reader for a moment): asked again next tick
      return null
    }
    knownLimits.set(row.id, known)
  }
  return known > 0 ? known : null
}

// The person's prompt: the tasks that ended leave the band, as the finished calls do.
export async function dropEndedTasks($: EngineInterface): Promise<void> {
  await update($, watchAtom, w => {
    const band = w.band ?? []
    const kept: BandTask[] = []
    for (const task of band) {
      if (isActiveState(task.state)) kept.push(task)
    }
    return kept.length === band.length ? w : { ...w, band: kept }
  })
}

async function scan($: EngineInterface, now: number): Promise<void> {
  lastReadAt = now
  if (dataHomeFound === null) dataHomeFound = await dataHome($)
  const home = dataHomeFound
  if (home === null) return
  const index = await readIndex($, home)
  if (index === null) return
  const rows = index.rows
  // The Delegated tab reads its own view when the index changed under it: this
  // is its only clock, and a tab that is not shown reads nothing.
  const isIndexChanged = lastIndexSignature !== null && index.signature !== lastIndexSignature
  lastIndexSignature = index.signature
  if (isIndexChanged) void refreshDelegatedIfShown($).catch(() => undefined)

  if (isWindowsFound === null) isWindowsFound = (await platformOf($)) === 'windows'
  const isWindows = isWindowsFound
  // The session id is read every tick: a /clear gives the process a new one.
  const facts: ScanFacts = { home, now, sessionId: await $.session.id(), isWindows, beats: new Map() }
  // The root, not the cwd: a Bash cd moves the cwd, never the project.
  if (sessionProjectFound === null) sessionProjectFound = projectKey(await $.session.root(), isWindows)
  const sessionProject = sessionProjectFound
  const isSweep = isSweepPending
  const watched = await read($, watchAtom)
  const owned = new Set<string>(watched.owned)
  for (const id of ownedBeforeClear) owned.add(id)
  const earlierSessions = new Set<string>(earlierSessionIds)
  for (const id of watched.earlierSessions ?? []) earlierSessions.add(id)
  const claimed: string[] = []
  const elsewhere: DelegateElsewhere[] = []
  const awayRows: TaskRow[] = []
  const notices: Notice[] = []
  const seenTasks: BandTask[] = []
  let notified: string[] | null = null
  let isOwnedTaskActive = false

  for (const row of rows) {
    const isUnreported = row.reportedAt === null
    let rowProject = projectKeys.get(row.project)
    if (rowProject === undefined) {
      rowProject = projectKey(row.project, isWindows)
      projectKeys.set(row.project, rowProject)
    }
    if (rowProject !== sessionProject) {
      if (AWAY_STATES.includes(row.state) && isUnreported && !(await ownerIsLive($, facts, row))) {
        elsewhere.push({ id: row.id, project: row.project, worker: row.worker, title: oneLine(row.title, TITLE_CAP), state: row.state })
      }
      continue
    }

    // A row another live session names as owner is that session's now (its
    // delegate_send took the task over), whatever this session once held.
    // A row owned by an id this process had before a /clear is this session's.
    const isOwnId = row.ownerSession === facts.sessionId || (row.ownerSession !== null && earlierSessions.has(row.ownerSession))
    const isTaken = row.ownerSession !== null && !isOwnId && (await ownerIsLive($, facts, row))
    if (isTaken) continue

    let isOwned = owned.has(row.id) || isOwnId
    let isOrphan = false
    // The first session to see an orphan of this project takes it. A cancelled
    // one is the person's own doing: nobody needs telling.
    const isWorthTaking = isUnreported && row.state !== 'merged' && row.state !== 'cancelled'
    if (!isOwned && isWorthTaking && !(await ownerIsLive($, facts, row)) && (await claim($, facts, row.id))) {
      owned.add(row.id)
      claimed.push(row.id)
      isOwned = true
      isOrphan = true
    }
    if (!isOwned) continue
    seenTasks.push(bandTaskOf({ ...row, timeLimitMs: await timeLimitOf($, home, row) }))

    if (isActiveState(row.state)) isOwnedTaskActive = true
    // Reported (delegate_result, delegate_merge): Claude has dealt with it.
    // delegate_send resets the mark when the task runs anew.
    if (!isUnreported) continue
    if (!isOrphan) await keepClaim($, facts, row.id)
    if (notified === null && (WAKE_STATES.includes(row.state) || row.queueWaitingLong)) {
      notified = await loadNotified($)
    }
    const known = notified ?? []

    if (isSweep && AWAY_STATES.includes(row.state) && (isOrphan || !(await ownerIsLive($, facts, row)))) {
      if (!known.includes(keyOf(row))) awayRows.push(row)
      continue
    }
    if (WAKE_STATES.includes(row.state) && !known.includes(keyOf(row))) notices.push(wakeNotice(row))
    if (row.state === 'queued' && row.queueWaitingLong && !known.includes(waitingLongKey(row))) notices.push(waitingLongNotice(row))
  }

  isFast = isOwnedTaskActive
  isSweepPending = false
  if (isSweep) {
    try {
      await dropOldClaims($, rows)
    } catch {
      // stale claims stay until the next start
    }
  }

  const sameElsewhere = JSON.stringify(elsewhere) === JSON.stringify(watched.elsewhere)
  if (claimed.length > 0 || !sameElsewhere || JSON.stringify(nextBand(watched.band ?? [], seenTasks)) !== JSON.stringify(watched.band ?? [])) {
    // The band is worked out again inside the write: a prompt may have dropped ended tasks since the read.
    await update($, watchAtom, w => ({ ...w, owned: addOwned(w.owned, claimed), elsewhere, band: nextBand(w.band ?? [], seenTasks) }))
  }

  if (awayRows.length === 0 && notices.length === 0) return
  const lines: string[] = []
  const headlines: string[] = []
  const newKeys: string[] = []
  if (awayRows.length > 0) {
    const items: string[] = []
    for (const row of awayRows) {
      items.push(awayItem(row))
      newKeys.push(keyOf(row))
    }
    lines.push(`consult: while you were away: ${items.join('; ')}. Read the details of each with delegate_result and tell the user.`)
    headlines.push(`consult: ${awayRows.length} delegated task${awayRows.length === 1 ? '' : 's'} ended while you were away.`)
  }
  for (const notice of notices) {
    lines.push(`${notice.promptHeadline} ${notice.ask}`)
    headlines.push(notice.headline)
    newKeys.push(notice.key)
  }
  // Marked before the prompt goes, so a failure after it is one lost notice,
  // never one repeated every few seconds.
  await saveNotified($, newKeys)
  // The prompt first, and neither waits for the other or for the tick to end:
  // a notification that hangs or is refused changes nothing.
  void $.prompt.submit({ text: lines.join('\n') }).catch(() => undefined)
  void $.ui.notify(headlines.join(' ').slice(0, NOTIFY_CAP)).catch(() => undefined)
}

async function tick($: EngineInterface): Promise<void> {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    if (isSweepPending || isFast || now - lastReadAt >= SLOW_READ_DUE_MS) await scan($, now)
    // The band redraws a running task's clock on this tick: every 5 s is plenty for a task of hours.
    if (isFast) await update($, tickAtom, n => n + 1)
  } finally {
    isTicking = false
  }
}

function armTicker($: EngineInterface): void {
  ticker = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => undefined)
  })
}

// Called from register.tsx's session.start hook in an interactive session. The
// first look is a moment after start-up, so it never holds start-up up.
export function startDelegateWatch($: EngineInterface): void {
  ticker?.cancel()
  isFast = false
  lastReadAt = 0
  lastIndexSignature = null
  dataHomeFound = null
  isWindowsFound = null
  sessionProjectFound = null
  projectKeys = new Map()
  claimStamps = new Map()
  knownLimits = new Map()
  isSweepPending = true
  armTicker($)
  $.clock.after(0, () => {
    void tick($).catch(() => undefined)
  })
}

// A delegate / delegate_send result that started a task: this session owns it.
// A follow-up that ends again has another end time, so it is told again.
async function noteStartedTask($: EngineInterface, ran: Ran): Promise<void> {
  if (ran.isError === true || ran.deny !== undefined) return
  const body = parseObject(textOf(ran))
  if (body === null || body.started !== true) return
  const id = body.id
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) return
  await update($, watchAtom, w => ({ ...w, owned: addOwned(w.owned, [id]) }))
  isFast = true
}

// A delegate_wait result lists the tasks that changed: Claude has just seen
// them, so no notice follows for those runs.
async function noteSeenTasks($: EngineInterface, ran: Ran): Promise<void> {
  if (ran.isError === true || ran.deny !== undefined) return
  const body = parseObject(textOf(ran))
  if (body === null || !Array.isArray(body.changed)) return
  const keys: string[] = []
  for (const value of body.changed) {
    const row = toRow(value)
    if (row !== null && WAKE_STATES.includes(row.state)) keys.push(keyOf(row))
  }
  if (keys.length > 0) await saveNotified($, keys)
}

// A /clear ends the session but not the process: the ending id joins the ones
// that count as this session's. Nothing slow: session.end shares a short bound.
async function noteClear($: EngineInterface, endingId: string): Promise<void> {
  // Kept in this process first, so a failing $.state below still leaves the old id known.
  if (!earlierSessionIds.includes(endingId)) earlierSessionIds = [...earlierSessionIds, endingId].slice(-EARLIER_SESSIONS_CAP)
  const watched = await read($, watchAtom)
  const earlier = [...earlierSessionIds]
  for (const id of watched.earlierSessions ?? []) {
    if (!earlier.includes(id)) earlier.push(id)
  }
  if (!earlier.includes(endingId)) earlier.push(endingId)
  earlierSessionIds = earlier.slice(-EARLIER_SESSIONS_CAP)
  ownedBeforeClear = addOwned(ownedBeforeClear, watched.owned)
  await update($, watchAtom, w => ({ ...w, earlierSessions: earlierSessionIds }))
}

export function registerDelegate(on: On): void {
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await noteClear($, e.sessionId)
      } catch {
        // the tasks of the old id are then found as orphans once its server is gone
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^mcp__plugin_consult_consult__delegate(_send|_wait)?$/ }, async ($, e, next) => {
    const ran = await next(e)
    try {
      if (shortToolName(e.tool) === 'delegate_wait') {
        await noteSeenTasks($, ran as Ran)
      } else {
        await noteStartedTask($, ran as Ran)
      }
    } catch {
      // the task is still found as an orphan once its server is gone
    }
    return ran
  }).catch(($, e, next) => next(e))
}
