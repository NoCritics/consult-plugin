import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { CallRecord, HistoryEntry } from '../types'
import { ANSWER_CAP, HISTORY_KEY, PROMPT_CAP, appendHistory, capText, readHistory, toHistoryEntry } from '../hooks/mod/history'
import { backgroundNotice } from './fixtures/results'

function storeDollar(entries: Record<string, unknown>, options: { rejectOver?: number } = {}): EngineInterface {
  const fake = {
    store: {
      get: async (key: string) => entries[key],
      set: async (key: string, value: unknown) => {
        if (options.rejectOver !== undefined && Array.isArray(value) && value.length > options.rejectOver) {
          throw new Error('store: over 4 MiB')
        }
        entries[key] = value
      },
    },
  }
  return fake as unknown as EngineInterface
}

function record(id: string, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id,
    tool: 'ask_codex',
    provider: 'codex',
    members: [],
    model: 'gpt-6-astra',
    effort: null,
    prompt: 'What is X?',
    startedAt: 1000,
    limitMs: 600000,
    status: 'answered',
    endedAt: 43000,
    summary: 'X is Y.',
    answer: 'X is Y.',
    answerTruncated: false,
    images: [],
    council: null,
    turnStartedAt: null,
    taskId: null,
    ...overrides,
  }
}

function entry(id: string): HistoryEntry {
  return toHistoryEntry(record(id), 'session-1')
}

describe('history', () => {
  test('capText at, below and above the cap', () => {
    expect(capText('abcd', 4)).toEqual({ text: 'abcd', truncated: false })
    expect(capText('abc', 4)).toEqual({ text: 'abc', truncated: false })
    expect(capText('abcde', 4)).toEqual({ text: 'abcd', truncated: true })
  })

  test('toHistoryEntry caps the answer and the prompt, drops limitMs', () => {
    const made = toHistoryEntry(record('a', { answer: 'x'.repeat(40 * 1024), prompt: 'p'.repeat(3 * 1024) }), 'session-1')
    expect(made.answer.length).toBe(ANSWER_CAP)
    expect(ANSWER_CAP).toBe(32768)
    expect(made.answerTruncated).toBe(true)
    expect(made.prompt.length).toBe(PROMPT_CAP)
    expect(PROMPT_CAP).toBe(2048)
    expect(made.durationMs).toBe(42000)
    expect(made.sessionId).toBe('session-1')
    expect('limitMs' in made).toBe(false)
  })

  test('appendHistory keeps the newest, newest first', async () => {
    const entries: Record<string, unknown> = {}
    const $ = storeDollar(entries)
    for (let n = 1; n <= 51; n++) {
      await appendHistory($, entry(`call-${n}`), 50)
    }
    const kept = entries[HISTORY_KEY] as HistoryEntry[]
    expect(kept.length).toBe(50)
    expect(kept[0]?.id).toBe('call-51')
    expect(kept[49]?.id).toBe('call-2')
  })

  test('appendHistory halves the list until the store takes it', async () => {
    const entries: Record<string, unknown> = {}
    const old: HistoryEntry[] = []
    for (let n = 1; n <= 10; n++) old.push(entry(`old-${n}`))
    entries[HISTORY_KEY] = old
    await appendHistory(storeDollar(entries, { rejectOver: 3 }), entry('new'), 50)
    const kept = entries[HISTORY_KEY] as HistoryEntry[]
    expect(kept.length <= 3).toBe(true)
    expect(kept[0]?.id).toBe('new')
  })

  test('appendHistory never throws when the store refuses everything', async () => {
    const entries: Record<string, unknown> = {}
    await appendHistory(storeDollar(entries, { rejectOver: 0 }), entry('new'), 50)
    expect(entries[HISTORY_KEY]).toBeUndefined()
  })

  test('readHistory over what this version did not write', async () => {
    expect(await readHistory(storeDollar({}))).toEqual([])
    expect(await readHistory(storeDollar({ [HISTORY_KEY]: 'oops' }))).toEqual([])
    const valid = entry('b')
    expect(await readHistory(storeDollar({ [HISTORY_KEY]: [{ id: 'a' }, null, 7, valid] }))).toEqual([valid])
  })

  test('readHistory hides entries that saved the background notice as their answer', async () => {
    // Before 0.10.0 handled background calls, a call moved to the background
    // at 120 s was recorded with Claude Code's notice as its answer.
    const notice = toHistoryEntry(record('bg', { answer: backgroundNotice('kayneto2o').text ?? '' }), 'session-1')
    const valid = entry('b')
    expect(await readHistory(storeDollar({ [HISTORY_KEY]: [notice, valid] }))).toEqual([valid])
    const quoting = toHistoryEntry(record('q', { answer: `Claude Code said: ${backgroundNotice('x1').text}` }), 'session-1')
    expect((await readHistory(storeDollar({ [HISTORY_KEY]: [quoting] }))).length).toBe(1)
  })

  test('readHistory fills fields an older entry lacks', async () => {
    const sparse = { id: 'c', status: 'answered', startedAt: 5 }
    const [read] = await readHistory(storeDollar({ [HISTORY_KEY]: [sparse] }))
    expect(read?.id).toBe('c')
    expect(read?.images).toEqual([])
    expect(read?.answer).toBe('')
    expect(read?.provider).toBe('')
  })
})
