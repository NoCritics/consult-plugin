// Times and bars as the band and the pane draw them.

function minutesAndSeconds(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// '42 s' under a minute, else 'm:ss'.
export function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))} s`
  return minutesAndSeconds(ms)
}

// A task's age on the Delegated tab: '42s', '1m36s', '12m', '2h05m'. Seconds
// show up to ten minutes, so the cell stays five wide.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 10) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, '0')}s`
  if (totalMinutes < 60) return `${totalMinutes}m`
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, '0')}m`
}

// Always 'm:ss': the band's elapsed / limit.
export function formatClock(ms: number): string {
  return minutesAndSeconds(ms)
}

// █ full, ▌ half, ░ empty; the fraction is clamped to 0..1.
export function progressBar(fraction: number, width = 15): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  const halves = Math.floor(clamped * width * 2)
  const full = Math.floor(halves / 2)
  const hasHalf = halves % 2 === 1
  const empty = width - full - (hasHalf ? 1 : 0)
  return '█'.repeat(full) + (hasHalf ? '▌' : '') + '░'.repeat(empty)
}

// Cut to at most `width` characters, an ellipsis marking the cut.
export function fitText(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return text.slice(0, Math.max(0, width - 1)) + '…'
}

// Cut to at most `width` characters keeping the END, an ellipsis marking the
// cut: the tail of a path is the part that tells one from another.
export function fitStart(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return '…' + text.slice(text.length - Math.max(0, width - 1))
}

// Bar colour by how much of the limit is gone: warning past 75 %, error past 90 %.
export function barColor(fraction: number): 'warning' | 'error' | undefined {
  if (fraction > 0.9) return 'error'
  if (fraction > 0.75) return 'warning'
  return undefined
}
