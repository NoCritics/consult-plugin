import { describe, expect, test } from 'claude-code/testing'

import { fitStart, fitText, formatElapsed } from '../hooks/mod/format'
import { busyText, labelTail, stateLabel } from '../hooks/mod/delegated'
import type { DelegateTaskRow } from '../types'

function row(overrides: Partial<DelegateTaskRow>): DelegateTaskRow {
  return {
    id: 'aaa111', worker: 'local', model: null, title: 't', state: 'running', location: 'copy', mode: 'write', summary: null, fenced: null, fence: null,
    stop_reason: null, queue_model: null, reported_at: null, keep_running: false, ended_at: null, started_at: null, elapsed_ms: null,
    folder: null, log_path: null, report_path: null, merged_files: null, first_conflict: null, clear_kind: 'refuse',
    ...overrides,
  }
}

describe('fitStart', () => {
  test('keeps the end of a path and marks the cut at the front', () => {
    expect(fitStart('C:\\Users\\user\\tasks\\ad4749\\log.jsonl', 20)).toBe('…ks\\ad4749\\log.jsonl')
    expect(fitStart('abcdef', 4)).toBe('…def')
  })

  test('text that fits is left alone, and no width gives nothing', () => {
    expect(fitStart('abc', 3)).toBe('abc')
    expect(fitStart('abc', 0)).toBe('')
    expect(fitStart('abcdef', 1)).toBe('…')
    expect(fitText('abcdef', 4)).toBe('abc…')
  })
})

describe('formatElapsed', () => {
  test('under a minute is seconds; under ten minutes is minutes and two-digit seconds', () => {
    expect(formatElapsed(48000)).toBe('48s')
    expect(formatElapsed(96000)).toBe('1m36s')
    expect(formatElapsed(61000)).toBe('1m01s')
    expect(formatElapsed(60000)).toBe('1m00s')
    expect(formatElapsed(9 * 60000 + 59999)).toBe('9m59s')
  })

  test('from ten minutes on it is minutes only, then hours and minutes', () => {
    expect(formatElapsed(10 * 60000 + 59000)).toBe('10m')
    expect(formatElapsed(12 * 60000)).toBe('12m')
    expect(formatElapsed(125 * 60000)).toBe('2h05m')
  })
})

describe('state labels', () => {
  const cases: { name: string; row: DelegateTaskRow; short: string; long: string; tail: string }[] = [
    { name: 'queued for a model', row: row({ state: 'queued', queue_model: 'qwen3.6' }), short: 'queued', long: 'queued · waits for qwen3.6', tail: 'waits for qwen3.6' },
    { name: 'queued for none', row: row({ state: 'queued' }), short: 'queued', long: 'queued', tail: '' },
    { name: 'conflict in a file', row: row({ state: 'conflict', first_conflict: 'src/auth.ts' }), short: 'conflict', long: 'conflict · src/auth.ts', tail: 'conflict in src/auth.ts' },
    { name: 'stopped for a reason', row: row({ state: 'stopped', stop_reason: 'time-limit' }), short: 'stopped', long: 'stopped · time-limit', tail: 'stopped: time-limit' },
    { name: 'done, read only', row: row({ state: 'done', mode: 'read' }), short: 'done · read only', long: 'done · read only', tail: '' },
    { name: 'merged files', row: row({ state: 'merged', merged_files: 2 }), short: 'merged · 2 files', long: 'merged · 2 files', tail: '' },
    { name: 'held', row: row({ state: 'held' }), short: 'held · for review', long: 'held · for review', tail: '' },
    { name: 'paused', row: row({ state: 'paused-limit' }), short: 'paused · limit', long: 'paused · limit', tail: '' },
    { name: 'cancelled', row: row({ state: 'cancelled' }), short: 'cancelled', long: 'cancelled', tail: '' },
  ]
  for (const one of cases) {
    test(`${one.name}: short, long and what the short one dropped`, () => {
      expect([stateLabel(one.row, false), stateLabel(one.row, true), stateLabel(one.row), labelTail(one.row)]).toEqual([one.short, one.long, one.long, one.tail])
    })
  }

  test('what a busy row says', () => {
    expect([busyText('cancel'), busyText('clear')]).toEqual(['cancelling…', 'clearing…'])
  })
})
