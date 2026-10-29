import type { EngineInterface } from 'claude-code'

// The one line under a finished call: the answer's first paragraph, or with
// `summary_model: haiku` a line haiku writes (billed to the user's usage).

const SUMMARY_MAX = 100

export function firstParagraphSummary(answer: string, max = SUMMARY_MAX): string {
  let paragraph = ''
  for (const block of answer.split(/\r?\n\s*\r?\n/)) {
    const collapsed = block.replace(/\s+/g, ' ').trim()
    if (collapsed !== '') {
      paragraph = collapsed
      break
    }
  }
  if (paragraph === '') return '(empty answer)'
  if (paragraph.length <= max) return paragraph
  return paragraph.slice(0, max - 1) + '…'
}

export async function haikuSummary($: EngineInterface, answer: string): Promise<string> {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      prompt:
        'Summarise this answer in one line under 100 characters. Reply with the line only.\n\n' +
        answer.slice(0, 16000),
      maxTokens: 80,
    })
    if (!reply.isAnswered) return firstParagraphSummary(answer)
    const line = firstParagraphSummary(reply.text)
    return line === '(empty answer)' ? firstParagraphSummary(answer) : line
  } catch {
    return firstParagraphSummary(answer)
  }
}
