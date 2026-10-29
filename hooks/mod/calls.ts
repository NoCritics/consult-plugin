import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CallRecord, CallStatus } from '../../types'
import { ANSWER_CAP, PROMPT_CAP, appendHistory, capText, toHistoryEntry } from './history'
import { announceFinish } from './notify'
import { TRACKED_TOOLS, backgroundTaskId, brokenService, interpretResult, parseTaskNotifications, providerOf, shortToolName } from './outcome'
import type { Outcome, Ran } from './outcome'
import { callLimitMs, loadConsultSettings } from './settings'
import { markBroken, markHealthy } from './health'
import type { ConsultSettings } from './settings'
import { firstParagraphSummary, haikuSummary } from './summary'

// The tool.call hook: a running record for each tracked consult call, the
// race against its Cancel button, and the finished record, history entry,
// toast and push. What Claude receives is never changed, except on Cancel.

export const CANCEL_DENY = 'Cancelled by the user from the consult band.'

export const callsAtom = atom({ plugin: 'consult', key: 'calls' } as const, [] as CallRecord[])
const finishedAtom = atom({ plugin: 'consult', key: 'finished' } as const, [] as string[])
const tickAtom = atom({ plugin: 'consult', key: 'tick' } as const, 0)
// When the latest prompt was sent (health.ts's prompt.submit hook writes it):
// each call keeps it as turnStartedAt.
const turnAtom = atom({ plugin: 'consult', key: 'turn' } as const, null as number | null)

// Cancel resolvers by call id; a hot reload loses them (development only).
const cancelResolvers = new Map<string, () => void>()
// Backgrounded calls whose TaskStop is under way.
const stoppingCalls = new Set<string>()
let ticker: { cancel: () => void } | null = null
// History writes read, then write the store: one at a time, so two calls
// finishing together cannot overwrite each other's entry.
let historyQueue: Promise<void> = Promise.resolve()

function queueHistory(write: () => Promise<void>): Promise<void> {
  historyQueue = historyQueue.then(write).catch(() => undefined)
  return historyQueue
}

// A call moved to the background with no task notification by its limit and
// this much more ends as a timeout, so its row never ticks on for good.
const BACKGROUND_GRACE_MS = 60000

function requestCancel(id: string): boolean {
  const resolve = cancelResolvers.get(id)
  if (resolve === undefined) return false
  cancelResolvers.delete(id)
  resolve()
  return true
}

function textArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : null
}

async function tickOnce($: EngineInterface): Promise<void> {
  let isRunning = false
  for (const call of await read($, callsAtom)) {
    if (call.status === 'running') isRunning = true
  }
  if (!isRunning) {
    ticker?.cancel()
    ticker = null
    return
  }
  await update($, tickAtom, n => n + 1)
}

function ensureTicker($: EngineInterface): void {
  if (ticker !== null) return
  ticker = $.clock.every(1000, () => {
    void tickOnce($).catch(() => undefined)
  })
}

function finishedRecord(record: CallRecord, status: CallStatus, endedAt: number, outcome: Outcome | null): CallRecord {
  if (outcome === null) {
    return { ...record, status, endedAt, summary: 'Cancelled from the band.' }
  }
  const answer = capText(outcome.answer, ANSWER_CAP)
  return {
    ...record,
    status,
    endedAt,
    model: outcome.model ?? record.model,
    effort: outcome.effort ?? record.effort,
    answer: answer.text,
    answerTruncated: answer.truncated,
    summary: firstParagraphSummary(outcome.answer),
    images: outcome.images,
    council: outcome.council,
  }
}

async function replaceRecord($: EngineInterface, record: CallRecord): Promise<void> {
  await update($, callsAtom, list => list.map(one => (one.id === record.id ? record : one)))
}

async function refineSummary($: EngineInterface, record: CallRecord, sessionId: string, settings: ConsultSettings): Promise<void> {
  const summary = await haikuSummary($, record.answer)
  const refined = { ...record, summary }
  await replaceRecord($, refined)
  await queueHistory(() => appendHistory($, toHistoryEntry(refined, sessionId), settings.historySize))
}

// An error that says a service is broken pins it; an answer from it clears it.
async function noteHealth($: EngineInterface, provider: string, outcome: Outcome): Promise<void> {
  if (outcome.status === 'error') {
    const broken = brokenService(provider, outcome.answer)
    if (broken !== null) await markBroken($, broken.service, broken.reason)
    return
  }
  if (outcome.status === 'answered' && (provider === 'codex' || provider === 'agy' || provider === 'local')) {
    await markHealthy($, provider)
  }
}

async function afterFinish($: EngineInterface, record: CallRecord, outcome: Outcome | null, settings: ConsultSettings): Promise<void> {
  let sessionId = ''
  try {
    sessionId = await $.session.id()
  } catch {
    // history entries without a session still read
  }
  await queueHistory(() => appendHistory($, toHistoryEntry(record, sessionId), settings.historySize))
  await announceFinish($, record, settings)
  if (outcome !== null) {
    try {
      await noteHealth($, record.provider, outcome)
    } catch {
      // health is best effort
    }
  }
  if (settings.summaryModel === 'haiku' && record.status === 'answered') {
    // Claude never waits for the haiku line: it lands after the call returns.
    $.clock.after(0, () => {
      void refineSummary($, record, sessionId, settings).catch(() => undefined)
    })
  }
}

async function safeNow($: EngineInterface, fallback: number): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return fallback
  }
}

// Leaves `running` for good, whatever fails: the record and the finished row
// are written now; history, toast, push and health run after Claude has the
// result, from a timer, so Claude never waits on them. A call already settled
// stays as it is: a Cancel whose TaskStop waited on a prompt while the answer
// arrived must not overwrite the answer.
async function settleRecord($: EngineInterface, done: CallRecord, outcome: Outcome | null, settings: ConsultSettings): Promise<void> {
  let isAlreadySettled = false
  try {
    await update($, callsAtom, list => {
      isAlreadySettled = false
      const next: CallRecord[] = []
      for (const one of list) {
        if (one.id !== done.id) {
          next.push(one)
        } else if (one.status !== 'running') {
          isAlreadySettled = true
          next.push(one)
        } else {
          next.push(done)
        }
      }
      return next
    })
    if (isAlreadySettled) return
    await update($, finishedAtom, ids => (ids.includes(done.id) ? ids : [...ids, done.id]))
  } catch {
    // the band may show a stale row; the call's result is unaffected
  }
  if (isAlreadySettled) return
  try {
    $.clock.after(0, () => {
      void afterFinish($, done, outcome, settings).catch(() => undefined)
    })
  } catch {
    // no history, toast or push for this call
  }
}

function runningCall(calls: CallRecord[], matches: (call: CallRecord) => boolean): CallRecord | null {
  for (const call of calls) {
    if (call.status === 'running' && matches(call)) return call
  }
  return null
}

async function settleBackgroundTimeout($: EngineInterface, id: string, settings: ConsultSettings): Promise<void> {
  const call = runningCall(await read($, callsAtom), one => one.id === id)
  if (call === null) return
  const outcome: Outcome = {
    status: 'timeout',
    answer: 'No result came back from the background task within the time limit.',
    model: null,
    effort: null,
    images: [],
    council: null,
  }
  await settleRecord($, finishedRecord(call, 'timeout', await safeNow($, call.startedAt), outcome), outcome, settings)
}

// The call keeps running as a background task: its record stays running with
// the task's id until the task notification (or the backstop) settles it.
async function keepInBackground($: EngineInterface, record: CallRecord, settings: ConsultSettings): Promise<void> {
  await replaceRecord($, record)
  const now = await safeNow($, record.startedAt)
  const waitMs = Math.max(0, record.startedAt + record.limitMs + BACKGROUND_GRACE_MS - now)
  $.clock.after(waitMs, () => {
    void settleBackgroundTimeout($, record.id, settings).catch(() => undefined)
  })
}

// Called from register.tsx's prompt.submit hook with a task notification's
// text: settles the backgrounded call whose task it reports on.
export async function settleFromNotification($: EngineInterface, text: string): Promise<void> {
  for (const notified of parseTaskNotifications(text)) {
    const record = runningCall(await read($, callsAtom), call => call.taskId === notified.taskId)
    if (record === null) continue
    const settings = await loadConsultSettings($)
    const endedAt = await safeNow($, record.startedAt)
    if (notified.status === 'killed') {
      await settleRecord($, finishedRecord(record, 'cancelled', endedAt, null), null, settings)
      continue
    }
    const ran: Ran = notified.status === 'completed' ? { text: notified.result } : { isError: true, text: notified.result || `background task ${notified.status}` }
    const outcome = interpretResult(record.tool, ran)
    await settleRecord($, finishedRecord(record, outcome.status, endedAt, outcome), outcome, settings)
  }
}

// The band's Cancel: ends the race while the call runs in the turn; once it
// moved to the background, stops its task with TaskStop.
export async function cancelCall($: EngineInterface, id: string): Promise<void> {
  if (requestCancel(id)) return
  const record = runningCall(await read($, callsAtom), call => call.id === id && call.taskId !== null)
  if (record === null || record.taskId === null) return
  // TaskStop may wait on a permission prompt: one stop per call at a time.
  if (stoppingCalls.has(record.id)) return
  stoppingCalls.add(record.id)
  let isStopped = false
  try {
    const stopped = await $.tool.call({ tool: 'TaskStop', task_id: record.taskId })
    isStopped = stopped.deny === undefined && stopped.isError !== true
  } catch {
    isStopped = false
  } finally {
    stoppingCalls.delete(record.id)
  }
  if (!isStopped) {
    // The task may have finished, and its call settled, while TaskStop waited.
    const stillRunning = runningCall(await read($, callsAtom), call => call.id === record.id)
    if (stillRunning !== null) {
      $.ui.toast(`consult: could not stop ${record.provider} here: ask Claude to stop task ${record.taskId}`)
    }
    return
  }
  const settings = await loadConsultSettings($)
  await settleRecord($, finishedRecord(record, 'cancelled', await safeNow($, record.startedAt), null), null, settings)
}

export function registerCalls(on: On): void {
  on('tool.call', { tool: /^mcp__plugin_consult_consult__/ }, async ($, e, next) => {
    const tool = shortToolName(e.tool)
    if (tool === null || !TRACKED_TOOLS.includes(tool)) return next(e)

    const args = e as unknown as Record<string, unknown>
    const settings = await loadConsultSettings($)
    const startedAt = await $.clock.now()
    const turnStartedAt = await read($, turnAtom)
    const { provider, members } = providerOf(tool, args)
    const record: CallRecord = {
      id: e.tool_use_id || `${tool}-${startedAt}`,
      tool,
      provider,
      members,
      model: textArg(args, 'model'),
      effort: textArg(args, 'reasoning_effort') ?? textArg(args, 'effort'),
      prompt: capText(textArg(args, 'prompt') ?? '', PROMPT_CAP).text,
      startedAt,
      limitMs: callLimitMs(tool, args, settings, settings.defaults),
      status: 'running',
      endedAt: null,
      summary: '',
      answer: '',
      answerTruncated: false,
      images: [],
      council: null,
      turnStartedAt,
      taskId: null,
    }
    await update($, callsAtom, list => [...list.filter(one => one.id !== record.id), record])
    ensureTicker($)

    let cancel: () => void = () => undefined
    const cancelled = new Promise<'cancelled'>(resolve => {
      cancel = () => resolve('cancelled')
    })
    cancelResolvers.set(record.id, cancel)
    const running = next(e)
    // On Cancel the call beneath is abandoned; whatever it settles to is dropped.
    running.catch(() => undefined)
    let first: Awaited<typeof running> | 'cancelled'
    try {
      first = await Promise.race([running, cancelled])
    } catch (error) {
      // The call beneath threw: record it, then let the .catch pass it on.
      const failure: Outcome = { status: 'error', answer: String(error), model: null, effort: null, images: [], council: null }
      await settleRecord($, finishedRecord(record, 'error', await safeNow($, startedAt), failure), failure, settings)
      throw error
    } finally {
      cancelResolvers.delete(record.id)
    }

    const endedAt = await safeNow($, startedAt)
    if (first === 'cancelled') {
      await settleRecord($, finishedRecord(record, 'cancelled', endedAt, null), null, settings)
      return { deny: CANCEL_DENY }
    }

    const taskId = backgroundTaskId(tool, first as Ran)
    if (taskId !== null) {
      // Claude Code moved the call to the background at 120 s: it still runs,
      // and its result comes as a task notification. Claude gets the notice.
      await keepInBackground($, { ...record, taskId }, settings)
      return first
    }

    const outcome = interpretResult(tool, first as Ran)
    await settleRecord($, finishedRecord(record, outcome.status, endedAt, outcome), outcome, settings)
    return first
  }).catch(($, e, next) => next(e))
}
