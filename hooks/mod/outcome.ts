import type { CallStatus, CouncilInfo, ImageRef, ServiceName } from '../../types'

// Reading what consult's MCP server returned: its JSON text for answers, an
// error text for failures. Anything else is still an answer with its text.

const TOOL_PREFIX = 'mcp__plugin_consult_consult__'

export const TRACKED_TOOLS: readonly string[] = [
  'ask_codex',
  'ask_agy',
  'ask_local',
  'ask_gemini',
  'agy_generate_image',
  'codex_generate_image',
  'consult_chat_start',
  'consult_chat_send',
  'council_vote',
]

export const COUNCIL_DEFAULT_MEMBERS: readonly string[] = ['claude', 'codex', 'agy']

export function shortToolName(full: string): string | null {
  return full.startsWith(TOOL_PREFIX) ? full.slice(TOOL_PREFIX.length) : null
}

// What kind of call a tool makes, as the band's rows start; a council names itself.
export function kindOfTool(tool: string): 'ask' | 'chat' | 'image' | null {
  if (tool.startsWith('ask_')) return 'ask'
  if (tool === 'consult_chat_start' || tool === 'consult_chat_send') return 'chat'
  if (tool === 'agy_generate_image' || tool === 'codex_generate_image') return 'image'
  return null
}

export function providerOf(tool: string, args: Record<string, unknown>): { provider: string; members: string[] } {
  if (tool === 'ask_codex' || tool === 'codex_generate_image') return { provider: 'codex', members: [] }
  if (tool === 'ask_agy' || tool === 'agy_generate_image') return { provider: 'agy', members: [] }
  if (tool === 'ask_local') return { provider: 'local', members: [] }
  if (tool === 'ask_gemini') return { provider: 'gemini', members: [] }
  if (tool === 'consult_chat_start' || tool === 'consult_chat_send') {
    return { provider: typeof args.participant === 'string' ? args.participant : 'chat', members: [] }
  }
  if (tool === 'council_vote') {
    const members: string[] = []
    if (Array.isArray(args.participants)) {
      for (const one of args.participants) {
        if (typeof one === 'string') members.push(one)
      }
    }
    return { provider: 'council', members: members.length > 0 ? members : [...COUNCIL_DEFAULT_MEMBERS] }
  }
  return { provider: tool, members: [] }
}

export type Outcome = {
  status: Exclude<CallStatus, 'running' | 'cancelled'>
  answer: string
  model: string | null
  effort: string | null
  images: ImageRef[]
  council: CouncilInfo | null
  // consult saved a very long answer to a file and returned its start.
  answerSaved?: true
}

export type Ran = { result?: unknown; text?: string; isError?: true; deny?: string }

// The text the model read: core's `text`, else the text blocks of the result.
export function textOf(ran: Ran): string {
  if (typeof ran.text === 'string') return ran.text
  const result = ran.result
  if (typeof result === 'string') return result
  let blocks: unknown = result
  if (result !== null && typeof result === 'object' && !Array.isArray(result) && 'content' in result) {
    blocks = (result as { content: unknown }).content
  }
  if (!Array.isArray(blocks)) return ''
  const texts: string[] = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') texts.push(text)
    }
  }
  return texts.join('\n')
}

export function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function outputImages(value: unknown): ImageRef[] {
  const images: ImageRef[] = []
  if (!Array.isArray(value)) return images
  for (const one of value) {
    if (one === null || typeof one !== 'object') continue
    const image = one as Record<string, unknown>
    if (typeof image.path !== 'string') continue
    images.push({
      path: image.path,
      width: typeof image.width === 'number' ? image.width : null,
      height: typeof image.height === 'number' ? image.height : null,
      bytes: typeof image.bytes === 'number' ? image.bytes : 0,
    })
  }
  return images
}

function councilOf(body: Record<string, unknown>): { council: CouncilInfo; answer: string } {
  const members: string[] = []
  const scores = body.scores
  if (scores !== null && typeof scores === 'object') {
    for (const score of Object.values(scores)) {
      const model = (score as { model?: unknown } | null)?.model
      if (typeof model === 'string') members.push(model)
    }
  }
  const tied = body.tied === true
  let answer = typeof body.winner_response === 'string' ? body.winner_response : ''
  if (tied && body.candidates !== null && typeof body.candidates === 'object') {
    const parts: string[] = []
    for (const candidate of Object.values(body.candidates)) {
      const one = candidate as { model?: unknown; response?: unknown } | null
      if (typeof one?.response === 'string') parts.push(`**${String(one.model ?? '?')}**: ${one.response}`)
    }
    answer = parts.join('\n\n')
  }
  return { council: { winner: textOrNull(body.winner_model), tied, members }, answer }
}

export function interpretResult(tool: string, ran: Ran): Outcome {
  const none = { model: null, effort: null, images: [], council: null }
  if (typeof ran.deny === 'string') return { status: 'error', answer: ran.deny, ...none }
  const text = textOf(ran)
  if (ran.isError) {
    return { status: text.startsWith('INCOMPLETE:') ? 'timeout' : 'error', answer: text, ...none }
  }
  const body = parseObject(text)
  if (body === null) return { status: 'answered', answer: text, ...none }
  const model = textOrNull(body.model)
  const effort = textOrNull(body.reasoning_effort)
  if (tool === 'council_vote' && ('winner_response' in body || 'tied' in body)) {
    const { council, answer } = councilOf(body)
    return { status: 'answered', answer, model: null, effort: null, images: [], council }
  }
  if ((tool === 'agy_generate_image' || tool === 'codex_generate_image') && Array.isArray(body.images)) {
    const images = outputImages(body.images)
    const lines: string[] = []
    for (const image of images) lines.push(image.path)
    if (typeof body.warning === 'string') lines.push('', body.warning)
    return { status: 'answered', answer: lines.join('\n'), model, effort, images, council: null }
  }
  if (typeof body.response === 'string') {
    if (typeof body.full_answer_path === 'string') {
      return { status: 'answered', answer: body.response, model, effort, images: [], council: null, answerSaved: true }
    }
    return { status: 'answered', answer: body.response, model, effort, images: [], council: null }
  }
  return { status: 'answered', answer: text, model, effort, images: [], council: null }
}

// Claude Code moves an MCP call still running at 120 s to the background and
// answers the call with a notice naming the task (2.1.302: "... It was moved
// to the background as task kayneto2o and keeps running; ..."). The task's
// result comes later as a task notification. Only that exact notice, from its
// first word and naming this tool, counts: an answer quoting it must not make
// the band wait on, or Cancel stop, some other task.
const BACKGROUND_NOTICE =
  /^MCP tool "[^"\/]+\/([A-Za-z0-9_]+)" is still running after \d+s\. It was moved to the background as task ([A-Za-z0-9_-]+) and keeps running;/

// Whether a text is that notice, from its first word.
export function isBackgroundNotice(text: string): boolean {
  return BACKGROUND_NOTICE.test(text)
}

export function backgroundTaskId(tool: string, ran: Ran): string | null {
  if (typeof ran.deny === 'string' || ran.isError) return null
  const found = BACKGROUND_NOTICE.exec(textOf(ran))
  if (found === null || found[1] !== tool) return null
  return found[2] as string
}

export type TaskNotification = { taskId: string; status: string; result: string }

// Every task notification in a prompt's text: the engine may join several
// that were queued together. Blocks are split where a line opens a new one
// with its <task-id>. An answer is JSON, whose strings carry no raw line
// breaks, so it cannot split a block; an error or INCOMPLETE result is plain
// text and could, but a forged block only touches another consult call's
// row and history, never TaskStop or what Claude reads. None when the text
// does not start with a notification.
const NEXT_NOTIFICATION = /\r?\n(?=<task-notification>\r?\n<task-id>)/

export function parseTaskNotifications(text: string): TaskNotification[] {
  const notifications: TaskNotification[] = []
  if (!text.trimStart().startsWith('<task-notification>')) return notifications
  for (const block of text.split(NEXT_NOTIFICATION)) {
    const notification = parseTaskNotification(block)
    if (notification !== null) notifications.push(notification)
  }
  return notifications
}

// One task notification's text: <task-notification> with <task-id>,
// <status> and the task's result between <result> lines. null for any other.
export function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.trimStart().startsWith('<task-notification>')) return null
  const taskId = /<task-id>([^<]*)<\/task-id>/.exec(text)
  const status = /<status>([^<]*)<\/status>/.exec(text)
  if (taskId === null || status === null) return null
  const resultStart = text.indexOf('<result>')
  const resultEnd = text.lastIndexOf('</result>')
  let result = ''
  if (resultStart >= 0 && resultEnd > resultStart) {
    result = text.slice(resultStart + '<result>'.length, resultEnd).replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  }
  return { taskId: (taskId[1] as string).trim(), status: (status[1] as string).trim(), result }
}

export function brokenService(provider: string, text: string): { service: ServiceName; reason: string } | null {
  if (provider === 'codex') {
    if (/CLI not found|not on PATH|not installed/i.test(text)) return { service: 'codex', reason: 'not installed' }
    // Not the server's "Run `codex login`" hint: it is added to any failure
    // that mentions a token, a token limit included.
    if (/not logged in|refresh token|\b401\b|unauthorized/i.test(text)) {
      return { service: 'codex', reason: 'not signed in — run codex login' }
    }
    return null
  }
  if (provider === 'agy') {
    if (/binary_missing|CLI not found|not on PATH|not installed/i.test(text)) return { service: 'agy', reason: 'not installed' }
    if (/not signed in|authenticat|sign-in/i.test(text)) return { service: 'agy', reason: 'not signed in — run agy once' }
    if (/ineligible/i.test(text)) return { service: 'agy', reason: 'account not eligible' }
    return null
  }
  if (provider === 'local') {
    if (/ECONNREFUSED|unreachable|is not running|No local model runner is listening/i.test(text)) {
      return { service: 'local', reason: 'runner not reachable' }
    }
    if (/No local model configured/i.test(text)) return { service: 'local', reason: 'no local_model set' }
    return null
  }
  return null
}
