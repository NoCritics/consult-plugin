// consult's real result shapes, as the model reads them (the tool's JSON text),
// for tests that stand a hook in for consult's MCP server.

export type RanResult = { result?: unknown; text?: string; isError?: true }

function answered(body: Record<string, unknown>): RanResult {
  const text = JSON.stringify(body, null, 2)
  return { result: [{ type: 'text', text }], text }
}

function failed(text: string): RanResult {
  return { isError: true, result: text, text }
}

export const CODEX_ANSWER = answered({
  response: 'Use a tagged union instead of the boolean flags; it makes the states explicit.\n\nSecond paragraph.',
  model: 'gpt-6-astra',
  reasoning_effort: 'high',
  latency_ms: 42000,
  hooks_ran: false,
})

export const CODEX_ANSWER_WITH_INPUT_IMAGE = answered({
  response: 'The screenshot shows a login form.',
  model: 'gpt-6-astra',
  reasoning_effort: 'medium',
  latency_ms: 30000,
  hooks_ran: false,
  images: [{ path: 'C:\\shots\\login.png', type: 'png', width: 800, height: 600 }],
})

export const AGY_ANSWER_WITH_DENIED = answered({
  response: 'From memory: X is Y.',
  denied_actions: ['run_command: ls'],
  model: 'gemini-3.5-pro',
  session_id: null,
  latency_ms: 21000,
  num_turns: 2,
  tokens: { input: 10, output: 20, thinking: null, cache_read: null },
})

export const LOCAL_ANSWER = answered({
  response: 'Local says hi.',
  model: 'qwen3.5:9b',
  latency_ms: 4000,
  base_url: 'http://127.0.0.1:11434/v1',
  finish_reason: 'stop',
  tokens: { prompt: 5, completion: 4, total: 9 },
  reasoning_chars: 0,
})

export const IMAGE_ANSWER = answered({
  images: [
    { path: 'C:\\proj\\consult-images\\red apple.jpg', type: 'jpeg', width: 1024, height: 1024, bytes: 204800 },
    { path: 'C:\\proj\\consult-images\\pomme é.png', type: 'png', width: 512, height: 512, bytes: 51200 },
  ],
  output_dir: 'C:\\proj\\consult-images',
  agy_reply: 'Saved two images.',
  model: 'gemini-3.5-flash-image',
  latency_ms: 92000,
})

export const IMAGE_PARTIAL = answered({
  images: [{ path: 'C:\\proj\\consult-images\\one.jpg', type: 'jpeg', width: 640, height: 480, bytes: 9000 }],
  output_dir: 'C:\\proj\\consult-images',
  warning: 'agy did not finish cleanly (timeout). The 1 image(s) it had already saved are kept; it may have meant to make more.',
  model: '(agy default)',
})

export const CODEX_IMAGE_ANSWER = answered({
  images: [{ path: 'C:\\proj\\consult-images\\gpt cat.png', type: 'png', width: 1024, height: 1536, bytes: 300000 }],
  output_dir: 'C:\\proj\\consult-images',
  codex_reply: 'Saved one image.',
  model: 'gpt-5.5',
  latency_ms: 80000,
  aspect_ratio: '2:3',
  transparent_background: false,
  count: 1,
})

export const CODEX_IMAGE_PARTIAL = answered({
  images: [{ path: 'C:\\proj\\consult-images\\one.png', type: 'png', width: 1024, height: 1024, bytes: 9000 }],
  output_dir: 'C:\\proj\\consult-images',
  warning: 'Codex did not finish cleanly (timeout). The 1 image(s) it had already saved are kept; it may have meant to make more.',
  model: 'gpt-5.5',
})

export const COUNCIL_WINNER = answered({
  winner: 'B',
  winner_model: 'codex',
  winner_response: 'Codex wins: use a tagged union.',
  scores: { A: { model: 'claude', borda: 2 }, B: { model: 'codex', borda: 4 }, C: { model: 'agy', borda: 0 } },
  tied: false,
  tied_at_top: ['B'],
  degraded: false,
  total_latency_ms: 72000,
})

export const COUNCIL_TIE = answered({
  winner: null,
  winner_model: null,
  winner_response: null,
  scores: { A: { model: 'claude', borda: 3 }, B: { model: 'codex', borda: 3 } },
  tied: true,
  tied_at_top: ['A', 'B'],
  degraded: false,
  total_latency_ms: 65000,
  candidates: {
    A: { model: 'claude', response: 'Claude says A.', latency_ms: 1 },
    B: { model: 'codex', response: 'Codex says B.', latency_ms: 1 },
  },
})

export const CODEX_INCOMPLETE = failed(
  'INCOMPLETE: codex did not finish within 30000ms, so there is no complete answer. Do not treat any text below as the full response. Retry with `timeout_s: 60` (up to 1800), raise `codex_timeout_ms` in .claude/consult.local.md, or narrow the prompt.',
)

export const CODEX_NOT_SIGNED_IN = failed(
  'codex exec failed: 401 Unauthorized. Run `codex login` in a terminal, or call the `codex_login_start` tool.',
)

export const AGY_BINARY_MISSING = failed(
  'agy CLI not found on PATH or in its default install location. If you just installed it, open a NEW terminal and start Claude Code from there.',
)

export const PLAIN_TEXT = { result: [{ type: 'text', text: 'just some words' }], text: 'just some words' }

export const CONTENT_WITH_IMAGE_BLOCK = {
  result: [
    { type: 'text', text: 'Here is a picture.' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
  ],
}

export const JSON_WITHOUT_RESPONSE = answered({ status: 'ok', note: 'no response field here' })

// What a tool.call hook's next(e) resolves to when Claude Code moves an MCP
// call to the background at 120 s (Claude Code 2.1.302, from a live session).
export function backgroundNotice(taskId: string, tool = 'ask_codex'): RanResult {
  const text =
    `MCP tool "plugin:consult:consult/${tool}" is still running after 120s. It was moved to the background as task ${taskId} ` +
    `and keeps running; you'll receive a notification with the result when it completes. You can keep working in the meantime. ` +
    `To stop it, use TaskStop with task_id "${taskId}". Note: it does not survive exiting this session.`
  return { result: [{ type: 'text', text }], text }
}

// The prompt text of the task notification that later carries the result:
// the server's raw JSON text between <result> lines.
export function taskNotification(taskId: string, status: string, resultText: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<status>${status}</status>`,
    `<summary>MCP task ${taskId} (plugin:consult:consult/ask_codex) ${status}.</summary>`,
    '<result>',
    resultText,
    '</result>',
    '</task-notification>',
  ].join('\n')
}
