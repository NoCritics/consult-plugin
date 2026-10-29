import type { EngineInterface } from 'claude-code'

import type { CallRecord } from '../../types'
import { formatClock, formatDuration } from './format'
import type { ConsultSettings } from './settings'

// A toast for every finished call, and a push to the phone for long ones
// (`notify_after_s`; the engine skips it while the terminal is in use).

const PUSH_MAX = 200

function durationOf(record: CallRecord): number {
  return Math.max(0, (record.endedAt ?? record.startedAt) - record.startedAt)
}

export function toastText(record: CallRecord): string {
  if (record.status === 'answered') {
    return `consult: ✓ ${record.provider} · ${record.model ?? 'default'} · ${formatDuration(durationOf(record))}`
  }
  if (record.status === 'timeout') return `consult: ✗ ${record.provider} timed out after ${formatClock(record.limitMs)}`
  if (record.status === 'cancelled') return `consult: ${record.provider} cancelled`
  return `consult: ✗ ${record.provider} failed`
}

export function pushText(record: CallRecord): string {
  return `consult: ${record.provider} finished after ${formatDuration(durationOf(record))}`.slice(0, PUSH_MAX)
}

export async function announceFinish($: EngineInterface, record: CallRecord, s: ConsultSettings): Promise<void> {
  try {
    $.ui.toast(toastText(record))
  } catch {
    // a toast that fails is skipped
  }
  // A cancelled call was the user's own press: nothing to tell them.
  if (record.status === 'cancelled') return
  if (s.notifyAfterS <= 0 || durationOf(record) < s.notifyAfterS * 1000) return
  try {
    await $.tool.call({ tool: 'PushNotification', message: pushText(record), status: 'proactive' })
  } catch {
    // so is a push
  }
}
