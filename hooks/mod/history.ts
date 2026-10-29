import type { EngineInterface } from 'claude-code'

import type { CallRecord, CallStatus, HistoryEntry } from '../../types'
import { isBackgroundNotice } from './outcome'

// Calls kept across sessions in $.store, newest first. Worst case is about
// 50 x 34 KB, well under the store's 4 MiB.

export const PROMPT_CAP = 2048
export const ANSWER_CAP = 32768
export const HISTORY_KEY = 'history'

export function capText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  return { text: text.slice(0, cap), truncated: true }
}

export function toHistoryEntry(record: CallRecord, sessionId: string): HistoryEntry {
  const { limitMs, ...kept } = record
  const answer = capText(record.answer, ANSWER_CAP)
  return {
    ...kept,
    sessionId,
    prompt: capText(record.prompt, PROMPT_CAP).text,
    answer: answer.text,
    answerTruncated: record.answerTruncated || answer.truncated,
    durationMs: Math.max(0, (record.endedAt ?? record.startedAt) - record.startedAt),
  }
}

const FINISHED_STATUSES: CallStatus[] = ['answered', 'error', 'timeout', 'cancelled']

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// An entry this version did not write: keep it when it has an id, a known
// status and a start time, and fill what it lacks so the pane can draw it.
function toUsableEntry(value: unknown): HistoryEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.startedAt !== 'number') return null
  const status = FINISHED_STATUSES.find(one => one === raw.status)
  if (status === undefined) return null
  // Before background calls were followed, a call moved to the background at
  // 120 s was saved with Claude Code's notice as its answer: not an answer.
  if (typeof raw.answer === 'string' && isBackgroundNotice(raw.answer)) return null
  const images: HistoryEntry['images'] = []
  if (Array.isArray(raw.images)) {
    for (const image of raw.images) {
      if (image !== null && typeof image === 'object' && typeof (image as { path?: unknown }).path === 'string') {
        const one = image as Record<string, unknown>
        images.push({
          path: one.path as string,
          width: typeof one.width === 'number' ? one.width : null,
          height: typeof one.height === 'number' ? one.height : null,
          bytes: asNumber(one.bytes, 0),
        })
      }
    }
  }
  let council: HistoryEntry['council'] = null
  if (raw.council !== null && typeof raw.council === 'object') {
    const one = raw.council as Record<string, unknown>
    council = {
      winner: asTextOrNull(one.winner),
      tied: one.tied === true,
      members: Array.isArray(one.members) ? one.members.filter(member => typeof member === 'string') : [],
    }
  }
  return {
    id: raw.id,
    sessionId: asText(raw.sessionId),
    tool: asText(raw.tool),
    provider: asText(raw.provider),
    members: Array.isArray(raw.members) ? raw.members.filter(member => typeof member === 'string') : [],
    model: asTextOrNull(raw.model),
    effort: asTextOrNull(raw.effort),
    prompt: asText(raw.prompt),
    startedAt: raw.startedAt,
    status,
    endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : null,
    summary: asText(raw.summary),
    answer: asText(raw.answer),
    answerTruncated: raw.answerTruncated === true,
    images,
    council,
    turnStartedAt: typeof raw.turnStartedAt === 'number' ? raw.turnStartedAt : null,
    taskId: asTextOrNull(raw.taskId),
    durationMs: asNumber(raw.durationMs, 0),
  }
}

export async function readHistory($: EngineInterface): Promise<HistoryEntry[]> {
  let stored: unknown
  try {
    stored = await $.store.get(HISTORY_KEY)
  } catch {
    return []
  }
  if (!Array.isArray(stored)) return []
  const usable: HistoryEntry[] = []
  for (const value of stored) {
    const entry = toUsableEntry(value)
    if (entry !== null) usable.push(entry)
  }
  return usable
}

export async function appendHistory($: EngineInterface, entry: HistoryEntry, size: number): Promise<void> {
  const previous = await readHistory($)
  const withoutSame: HistoryEntry[] = []
  for (const one of previous) {
    if (one.id !== entry.id) withoutSame.push(one)
  }
  let kept = [entry, ...withoutSame].slice(0, Math.max(1, size))
  for (;;) {
    try {
      await $.store.set(HISTORY_KEY, kept)
      return
    } catch {
      if (kept.length <= 1) return
      kept = kept.slice(0, Math.ceil(kept.length / 2))
    }
  }
}
