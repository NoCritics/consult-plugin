import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { firstParagraphSummary, haikuSummary } from '../hooks/mod/summary'

function modelDollar(complete: (request: { model: string; prompt: string }) => Promise<unknown>): EngineInterface {
  return { model: { complete } } as unknown as EngineInterface
}

describe('summary', () => {
  test('firstParagraphSummary takes the first paragraph, whitespace collapsed', () => {
    expect(firstParagraphSummary('\n\nFirst  para\nline two\n\nSecond')).toBe('First para line two')
  })

  test('firstParagraphSummary cuts a long line at 100 with an ellipsis', () => {
    const cut = firstParagraphSummary('a'.repeat(300))
    expect(cut.length).toBe(100)
    expect(cut.endsWith('…')).toBe(true)
  })

  test('firstParagraphSummary on an empty answer', () => {
    expect(firstParagraphSummary('')).toBe('(empty answer)')
    expect(firstParagraphSummary('  \n\n ')).toBe('(empty answer)')
  })

  test('haikuSummary asks haiku for one line', async () => {
    let asked: { model: string; prompt: string } | null = null
    const $ = modelDollar(async request => {
      asked = request
      return { isAnswered: true, text: '  Use a tagged union.\n', usage: {} }
    })
    expect(await haikuSummary($, 'A long answer about unions.')).toBe('Use a tagged union.')
    expect(asked!.model).toBe('haiku')
    expect(asked!.prompt).toContain('A long answer about unions.')
  })

  test('haikuSummary falls back when the model throws or does not answer', async () => {
    const throwing = modelDollar(async () => {
      throw new Error('no network')
    })
    expect(await haikuSummary(throwing, 'First para.\n\nSecond.')).toBe('First para.')
    const refusing = modelDollar(async () => ({ isAnswered: false, reason: 'api-error', status: 529 }))
    expect(await haikuSummary(refusing, 'First para.')).toBe('First para.')
  })
})
