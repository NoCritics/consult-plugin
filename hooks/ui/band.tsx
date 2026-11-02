import { atom, read } from 'claude-code'
import type { EngineInterface, On, RenderNode } from 'claude-code'

import type { BandTask, CallRecord } from '../../types'
import { cancelCall } from '../mod/calls'
import { cancelTaskFromBand, isActiveState } from '../mod/delegated'
import { barColor, fitText, formatClock, formatDuration, formatElapsed, progressBar } from '../mod/format'
import { kindOfTool } from '../mod/outcome'
import { INITIAL_DELEGATE } from '../mod/state'
import { openPaneOn } from './pane'

// The band above the prompt: one row per running consult call and per running
// delegated task, with its bar and Cancel, then the Answers button. A row that
// ends while others run becomes its result line in place; after the last one
// ends, one slim row until the next prompt. With nothing to show, the engine's
// own band.

const callsAtom = atom({ plugin: 'consult', key: 'calls' } as const, [] as CallRecord[])
const finishedAtom = atom({ plugin: 'consult', key: 'finished' } as const, [] as string[])
const tickAtom = atom({ plugin: 'consult', key: 'tick' } as const, 0)
const watchAtom = atom({ plugin: 'consult', key: 'delegate' } as const, INITIAL_DELEGATE)

const LABEL_WIDTH = 32
const BAR_WIDTH = 15
const SHORT_LABEL_WIDTH = 16
const MIN_LABEL_WIDTH = 10
const MIN_BAR_WIDTH = 5
const BUTTONS_WIDTH = 12
const PREFIX = 'consult  '
const CLOCK_WIDTH = 13
// A running row around its label and bar: the prefix, the space after the
// label, the clock with a space before and two after, and `[ Cancel ]`.
const ROW_FIXED_WIDTH = PREFIX.length + 1 + (1 + CLOCK_WIDTH + 2) + '[ Cancel ]'.length
// The rounded grey frame, as compact-view's band: two border columns and one
// column of padding on each side.
const FRAME_COLOR = 'inactive'
const FRAME_WIDTH = 4
// Ended rows kept in place while others run; older ones fold into one line, so
// a long turn of many calls does not push the prompt up.
const MAX_ENDED_ROWS = 3

// How an ended task reads in the finished row, and whether it is a ✓.
const TASK_ENDINGS: Record<string, { text: string; isGood: boolean }> = {
  done: { text: 'finished', isGood: true },
  held: { text: 'finished, held for review', isGood: true },
  merged: { text: 'merged', isGood: true },
  failed: { text: 'failed', isGood: false },
  stopped: { text: 'stopped', isGood: false },
  conflict: { text: 'merge conflict', isGood: false },
  'paused-limit': { text: 'paused at its usage limit', isGood: false },
  cancelled: { text: 'cancelled', isGood: false },
}

// fraction is null for a task with no limit: its row has no bar.
type RunningRow = { key: string; label: string; fraction: number | null; clock: string; cancel: () => Promise<void> }
type FinishedItem = { isGood: boolean; isTask: boolean; head: string; tail: string; endedAt: number }
// One row of the frame, keyed by its call or task: running, or ended while others still run.
type BandRow = { kind: 'running'; key: string; row: RunningRow } | { kind: 'ended'; key: string; item: FinishedItem }

// A call's kind, provider and model, as both its rows start.
function callParts(call: CallRecord): string[] {
  const parts = [call.provider, call.model ?? 'default']
  const kind = kindOfTool(call.tool)
  if (kind !== null) parts.unshift(kind)
  return parts
}

function callLabel(call: CallRecord): string {
  if (call.provider === 'council') return `council · ${call.members.join(' ')}`
  const parts = callParts(call)
  if (call.effort !== null) parts.push(call.effort)
  return parts.join(' · ')
}

function taskParts(task: BandTask): string[] {
  const parts = ['delegate', task.worker, task.model ?? 'default']
  // First, so a narrowed row cuts the rest and keeps the marker: a lifted fence is never hidden while it acts.
  if (task.fence === 'full' || task.fence === 'none') parts.unshift('unfenced')
  return parts
}

function callRow($: EngineInterface, call: CallRecord, now: number): RunningRow {
  const elapsed = Math.max(0, now - call.startedAt)
  return {
    key: `cancel:${call.id}`,
    label: callLabel(call),
    fraction: call.limitMs > 0 ? elapsed / call.limitMs : 0,
    clock: call.provider === 'council' && elapsed > call.limitMs ? 'judge retry' : `${formatClock(elapsed)} / ${formatClock(call.limitMs)}`,
    cancel: () => cancelCall($, call.id),
  }
}

// A task's clock is in minutes and hours ('12m / 3h00m'): it can run for hours.
// Under a limit of ten hours or more the clock would not fit: the time alone.
function taskRow($: EngineInterface, task: BandTask, now: number): RunningRow {
  const elapsed = task.startedAt === null ? 0 : Math.max(0, now - task.startedAt)
  let clock = 'queued'
  if (task.startedAt !== null) {
    const withLimit = task.limitMs === null ? '' : `${formatElapsed(elapsed)} / ${formatElapsed(task.limitMs)}`
    clock = withLimit !== '' && withLimit.length <= CLOCK_WIDTH ? withLimit : formatElapsed(elapsed)
  }
  return {
    key: `cancel-task:${task.id}`,
    label: taskParts(task).join(' · '),
    fraction: task.limitMs === null ? null : elapsed / task.limitMs,
    clock,
    cancel: () => cancelTaskFromBand($, task.id),
  }
}

function callItem(call: CallRecord): FinishedItem {
  const parts = callParts(call)
  parts.push(formatDuration((call.endedAt ?? call.startedAt) - call.startedAt))
  return { isGood: call.status === 'answered', isTask: false, head: parts.join(' · '), tail: `"${call.summary}"`, endedAt: call.endedAt ?? call.startedAt }
}

function taskItem(task: BandTask): FinishedItem {
  const parts = taskParts(task)
  if (task.startedAt !== null && task.endedAt !== null) parts.push(formatElapsed(task.endedAt - task.startedAt))
  const ending = TASK_ENDINGS[task.state] ?? { text: task.state, isGood: false }
  return { isGood: ending.isGood, isTask: true, head: parts.join(' · '), tail: ending.text, endedAt: task.endedAt ?? 0 }
}

// The label and bar widths that fit the band, so a band narrowed by a docked
// pane does not wrap: the bar shrinks first, then the label, then the bar goes
// (the clock still says how far the call is), then the label shrinks again.
function rowWidths(bodyColumns: number): { label: number; bar: number } {
  const room = bodyColumns - FRAME_WIDTH - ROW_FIXED_WIDTH
  if (room >= LABEL_WIDTH + MIN_BAR_WIDTH) return { label: LABEL_WIDTH, bar: Math.min(BAR_WIDTH, room - LABEL_WIDTH) }
  if (room >= SHORT_LABEL_WIDTH + MIN_BAR_WIDTH) return { label: room - MIN_BAR_WIDTH, bar: MIN_BAR_WIDTH }
  return { label: Math.max(MIN_LABEL_WIDTH, room), bar: 0 }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function finishedLine(items: FinishedItem[], width: number): string {
  if (items.length === 1) {
    const item = items[0] as FinishedItem
    return fitText(`${item.isGood ? '✓' : '✗'} ${item.head} — ${item.tail}`, width)
  }
  let answers = 0
  let tasks = 0
  let errors = 0
  for (const item of items) {
    if (!item.isGood) errors += 1
    else if (item.isTask) tasks += 1
    else answers += 1
  }
  const parts: string[] = []
  if (answers > 0) parts.push(plural(answers, 'answer'))
  if (tasks > 0) parts.push(`${plural(tasks, 'task')} done`)
  if (errors > 0) parts.push(plural(errors, 'error'))
  return fitText(`${answers + tasks > 0 ? '✓' : '✗'} ${parts.join(' · ')}`, width)
}

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const calls = await read($, callsAtom)
    const finishedIds = await read($, finishedAtom)
    const tasks = (await read($, watchAtom)).band ?? []
    // Read so the drawing redraws every second while calls or tasks run.
    await read($, tickAtom)

    const now = await $.clock.now()
    // Every row in its place: one that ended while others run stays where it
    // was, as its result line, until the next prompt.
    const rows: BandRow[] = []
    let runningCount = 0
    // With no call among the rows, the button opens the Delegated tab: Answers lists no task.
    let hasCall = false
    for (const call of calls) {
      if (call.status === 'running') {
        rows.push({ kind: 'running', key: `call:${call.id}`, row: callRow($, call, now) })
        runningCount += 1
        hasCall = true
      } else if (finishedIds.includes(call.id)) {
        rows.push({ kind: 'ended', key: `call:${call.id}`, item: callItem(call) })
        hasCall = true
      }
    }
    for (const task of tasks) {
      if (isActiveState(task.state)) {
        rows.push({ kind: 'running', key: `task:${task.id}`, row: taskRow($, task, now) })
        runningCount += 1
      } else {
        rows.push({ kind: 'ended', key: `task:${task.id}`, item: taskItem(task) })
      }
    }
    if (rows.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const pane = hasCall
      ? <Button key="answers" label="Answers" onPress={() => openPaneOn($, 'answers')} />
      : <Button key="tasks" label="Tasks" onPress={() => openPaneOn($, 'delegated')} />

    const endedRows: { key: string; item: FinishedItem }[] = []
    for (const bandRow of rows) {
      if (bandRow.kind === 'ended') endedRows.push(bandRow)
    }

    if (runningCount === 0) {
      const items: FinishedItem[] = []
      for (const endedRow of endedRows) items.push(endedRow.item)
      const width = Math.max(10, e.props.bodyColumns - 10 - BUTTONS_WIDTH - FRAME_WIDTH)
      return (
        <Box flexDirection="row" borderStyle="round" borderColor={FRAME_COLOR} paddingX={1}>
          <Text bold>{PREFIX}</Text>
          <Text>{finishedLine(items, width)}  </Text>
          {pane}
        </Box>
      )
    }

    // The newest ended rows keep their places; the rest fold into one line above them.
    const newestFirst = [...endedRows].sort((first, second) => second.item.endedAt - first.item.endedAt)
    const keptKeys = new Set<string>()
    const folded: FinishedItem[] = []
    for (const endedRow of newestFirst) {
      if (keptKeys.size < MAX_ENDED_ROWS) keptKeys.add(endedRow.key)
      else folded.push(endedRow.item)
    }

    const widths = rowWidths(e.props.bodyColumns)
    // An ended row's line spans what a running row's label, bar, clock and Cancel take.
    const endedWidth = widths.label + widths.bar + ROW_FIXED_WIDTH - PREFIX.length
    const lines: RenderNode[] = []
    if (folded.length > 0) {
      lines.push(
        <Box key="folded" flexDirection="row">
          <Text bold>{PREFIX}</Text>
          <Text wrap="truncate">{finishedLine(folded, endedWidth)}</Text>
        </Box>
      )
    }
    for (const bandRow of rows) {
      if (bandRow.kind === 'ended' && !keptKeys.has(bandRow.key)) continue
      const prefix = <Text bold>{lines.length === 0 ? PREFIX : ' '.repeat(PREFIX.length)}</Text>
      if (bandRow.kind === 'ended') {
        lines.push(
          <Box key={bandRow.key} flexDirection="row">
            {prefix}
            <Text wrap="truncate">{finishedLine([bandRow.item], endedWidth)}</Text>
          </Box>
        )
        continue
      }
      const row = bandRow.row
      lines.push(
        <Box key={bandRow.key} flexDirection="row">
          {prefix}
          <Text wrap="truncate">{fitText(row.label, widths.label).padEnd(widths.label)} </Text>
          {widths.bar > 0 && row.fraction !== null ? (
            <Text color={barColor(row.fraction)}>
              {progressBar(row.fraction, widths.bar)}
            </Text>
          ) : null}
          {widths.bar > 0 && row.fraction === null ? <Text>{' '.repeat(widths.bar)}</Text> : null}
          <Text> {row.clock.padStart(CLOCK_WIDTH)}  </Text>
          <Button key={row.key} label="Cancel" onPress={row.cancel} />
        </Box>
      )
    }
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={FRAME_COLOR} paddingX={1}>
        {lines}
        <Box flexDirection="row" justifyContent="flex-end">
          {pane}
        </Box>
      </Box>
    )
  })
}
