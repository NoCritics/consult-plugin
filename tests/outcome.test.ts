import { describe, expect, test } from 'claude-code/testing'

import * as fixtures from './fixtures/results'
import { TRACKED_TOOLS, backgroundTaskId, brokenService, interpretResult, providerOf, shortToolName } from '../hooks/mod/outcome'

describe('outcome', () => {
  test("only Claude Code's own background notice for this tool names a task", () => {
    expect(backgroundTaskId('ask_codex', fixtures.backgroundNotice('task1'))).toBe('task1')
    // An answer that quotes the notice is an answer: its task id is not this call's.
    const quoted = JSON.stringify({ response: 'Claude Code said: It was moved to the background as task shell7 and keeps running.' })
    expect(backgroundTaskId('ask_codex', { result: [{ type: 'text', text: quoted }], text: quoted })).toBe(null)
    const prose = 'Note: the job was moved to the background as task shell7 and keeps running.'
    expect(backgroundTaskId('ask_codex', { text: prose })).toBe(null)
    // The notice names the tool it moved: another tool's notice is not this call's.
    expect(backgroundTaskId('ask_agy', fixtures.backgroundNotice('task1'))).toBe(null)
    expect(backgroundTaskId('ask_codex', { ...fixtures.backgroundNotice('task1'), isError: true })).toBe(null)
  })

  test('codex answer', () => {
    const outcome = interpretResult('ask_codex', fixtures.CODEX_ANSWER)
    expect(outcome.status).toBe('answered')
    expect(outcome.answer.startsWith('Use a tagged union')).toBe(true)
    expect(outcome.model).toBe('gpt-6-astra')
    expect(outcome.effort).toBe('high')
    expect(outcome.images).toEqual([])
  })

  test('the images codex was shown are not output images', () => {
    const outcome = interpretResult('ask_codex', fixtures.CODEX_ANSWER_WITH_INPUT_IMAGE)
    expect(outcome.images).toEqual([])
    expect(outcome.answer).toBe('The screenshot shows a login form.')
  })

  test('an answer saved to a file is marked as cut short', () => {
    const body = JSON.stringify({ response: 'The start.\n\n[The answer continues: 50000 characters in all. The full answer is in C:/a.md. Read it there, in parts.]', model: 'm', full_answer_path: 'C:/a.md', response_chars: 50000 })
    const saved = interpretResult('ask_agy', { result: [{ type: 'text', text: body }], text: body })
    expect(saved.answerSaved).toBe(true)
    expect(saved.answer).toContain('C:/a.md')
    expect(interpretResult('ask_codex', fixtures.CODEX_ANSWER).answerSaved).toBe(undefined)
  })

  test('agy answer with denied actions', () => {
    const outcome = interpretResult('ask_agy', fixtures.AGY_ANSWER_WITH_DENIED)
    expect(outcome.status).toBe('answered')
    expect(outcome.answer.startsWith('From memory')).toBe(true)
    expect(outcome.model).toBe('gemini-3.5-pro')
  })

  test('local answer', () => {
    const outcome = interpretResult('ask_local', fixtures.LOCAL_ANSWER)
    expect(outcome.answer).toBe('Local says hi.')
    expect(outcome.model).toBe('qwen3.5:9b')
  })

  test('image answer lists the paths and keeps the image facts', () => {
    const outcome = interpretResult('agy_generate_image', fixtures.IMAGE_ANSWER)
    expect(outcome.status).toBe('answered')
    expect(outcome.answer.startsWith('C:\\proj\\consult-images\\red apple.jpg\nC:\\proj\\consult-images\\pomme é.png')).toBe(true)
    expect(outcome.images).toEqual([
      { path: 'C:\\proj\\consult-images\\red apple.jpg', width: 1024, height: 1024, bytes: 204800 },
      { path: 'C:\\proj\\consult-images\\pomme é.png', width: 512, height: 512, bytes: 51200 },
    ])
    expect(outcome.model).toBe('gemini-3.5-flash-image')
  })

  test('image answer that kept a partial set carries the warning', () => {
    const outcome = interpretResult('agy_generate_image', fixtures.IMAGE_PARTIAL)
    expect(outcome.status).toBe('answered')
    expect(outcome.images.length).toBe(1)
    expect(outcome.answer).toContain('agy did not finish cleanly')
  })

  test('codex image answer lists the paths and keeps the image facts', () => {
    const outcome = interpretResult('codex_generate_image', fixtures.CODEX_IMAGE_ANSWER)
    expect(outcome.status).toBe('answered')
    expect(outcome.answer).toBe('C:\\proj\\consult-images\\gpt cat.png')
    expect(outcome.images).toEqual([{ path: 'C:\\proj\\consult-images\\gpt cat.png', width: 1024, height: 1536, bytes: 300000 }])
    expect(outcome.model).toBe('gpt-5.5')
  })

  test('codex image answer that kept a partial set carries the warning', () => {
    const outcome = interpretResult('codex_generate_image', fixtures.CODEX_IMAGE_PARTIAL)
    expect(outcome.status).toBe('answered')
    expect(outcome.images.length).toBe(1)
    expect(outcome.answer).toContain('Codex did not finish cleanly')
  })

  test('council winner', () => {
    const outcome = interpretResult('council_vote', fixtures.COUNCIL_WINNER)
    expect(outcome.status).toBe('answered')
    expect(outcome.answer).toBe('Codex wins: use a tagged union.')
    expect(outcome.council).toEqual({ winner: 'codex', tied: false, members: ['claude', 'codex', 'agy'] })
  })

  test('council tie', () => {
    const outcome = interpretResult('council_vote', fixtures.COUNCIL_TIE)
    expect(outcome.council).toEqual({ winner: null, tied: true, members: ['claude', 'codex'] })
    expect(outcome.answer).toContain('Claude says A.')
    expect(outcome.answer).toContain('Codex says B.')
  })

  test('INCOMPLETE is a timeout', () => {
    const outcome = interpretResult('ask_codex', fixtures.CODEX_INCOMPLETE)
    expect(outcome.status).toBe('timeout')
    expect(outcome.answer.startsWith('INCOMPLETE:')).toBe(true)
  })

  test('other errors are errors', () => {
    expect(interpretResult('ask_codex', fixtures.CODEX_NOT_SIGNED_IN).status).toBe('error')
    expect(interpretResult('ask_agy', fixtures.AGY_BINARY_MISSING).status).toBe('error')
  })

  test('a deny is an error with the deny text', () => {
    const outcome = interpretResult('ask_codex', { deny: 'Blocked by policy.' })
    expect(outcome.status).toBe('error')
    expect(outcome.answer).toBe('Blocked by policy.')
  })

  test('results that are not consult JSON are answers with their text', () => {
    expect(interpretResult('ask_codex', fixtures.PLAIN_TEXT)).toEqual(
      expect.objectContaining({ status: 'answered', answer: 'just some words', model: null }),
    )
    expect(interpretResult('ask_codex', fixtures.CONTENT_WITH_IMAGE_BLOCK).answer).toBe('Here is a picture.')
    expect(interpretResult('ask_agy', fixtures.JSON_WITHOUT_RESPONSE).answer).toContain('no response field here')
    expect(interpretResult('ask_agy', {}).answer).toBe('')
    expect(interpretResult('ask_agy', { text: 'null' }).answer).toBe('null')
  })

  test('shortToolName', () => {
    expect(shortToolName('mcp__plugin_consult_consult__ask_codex')).toBe('ask_codex')
    expect(shortToolName('mcp__gh__issue')).toBe(null)
    expect(TRACKED_TOOLS.length).toBe(9)
    expect(TRACKED_TOOLS.includes('agy_status')).toBe(false)
  })

  test('providerOf every tracked tool', () => {
    expect(providerOf('ask_codex', {})).toEqual({ provider: 'codex', members: [] })
    expect(providerOf('ask_agy', {})).toEqual({ provider: 'agy', members: [] })
    expect(providerOf('agy_generate_image', {})).toEqual({ provider: 'agy', members: [] })
    expect(providerOf('codex_generate_image', {})).toEqual({ provider: 'codex', members: [] })
    expect(TRACKED_TOOLS).toContain('codex_generate_image')
    expect(providerOf('ask_local', {})).toEqual({ provider: 'local', members: [] })
    expect(providerOf('ask_gemini', {})).toEqual({ provider: 'gemini', members: [] })
    expect(providerOf('consult_chat_start', { participant: 'agy' })).toEqual({ provider: 'agy', members: [] })
    expect(providerOf('consult_chat_send', { participant: 'codex' })).toEqual({ provider: 'codex', members: [] })
    expect(providerOf('council_vote', {})).toEqual({ provider: 'council', members: ['claude', 'codex', 'agy'] })
    expect(providerOf('council_vote', { participants: ['codex', 'local'] })).toEqual({ provider: 'council', members: ['codex', 'local'] })
  })

  test('brokenService patterns', () => {
    expect(brokenService('codex', fixtures.CODEX_NOT_SIGNED_IN.text ?? '')).toEqual({ service: 'codex', reason: 'not signed in — run codex login' })
    expect(brokenService('codex', 'Error: not logged in')).toEqual({ service: 'codex', reason: 'not signed in — run codex login' })
    expect(brokenService('codex', 'codex CLI not found on PATH')).toEqual({ service: 'codex', reason: 'not installed' })
    expect(brokenService('agy', fixtures.AGY_BINARY_MISSING.text ?? '')).toEqual({ service: 'agy', reason: 'not installed' })
    expect(brokenService('agy', 'reason: binary_missing')).toEqual({ service: 'agy', reason: 'not installed' })
    expect(brokenService('agy', 'agy: not signed in')).toEqual({ service: 'agy', reason: 'not signed in — run agy once' })
    expect(brokenService('agy', 'IneligibleTier: ineligible account')).toEqual({ service: 'agy', reason: 'account not eligible' })
    expect(brokenService('local', 'No local model runner is listening at http://127.0.0.1:11434/v1.')).toEqual({ service: 'local', reason: 'runner not reachable' })
    expect(brokenService('local', 'connect ECONNREFUSED 127.0.0.1:11434')).toEqual({ service: 'local', reason: 'runner not reachable' })
    expect(brokenService('local', 'No local model configured. Set `local_model` in .claude/consult.local.md')).toEqual({ service: 'local', reason: 'no local_model set' })
    expect(brokenService('codex', 'INCOMPLETE: codex did not finish within 30000ms')).toBe(null)
    expect(brokenService('gemini', 'not logged in')).toBe(null)
    expect(brokenService('codex', 'context too long: token limit exceeded. Run `codex login` in a terminal, or call the `codex_login_start` tool.')).toBe(null)
    expect(brokenService('codex', 'the model catalog in use is stale')).toBe(null)
  })
})
