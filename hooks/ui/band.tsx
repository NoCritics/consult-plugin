import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import type { CallRecord } from '../../types'
import { cancelCall } from '../mod/calls'
import { barColor, fitText, formatClock, formatDuration, progressBar } from '../mod/format'
import { openPaneOn } from './pane'

// The band above the prompt: one row per running consult call with its bar
// and Cancel, then the Answers button; after the last one ends, one slim row
// until the next prompt. With nothing to show, the engine's own band.

const callsAtom = atom({ plugin: 'consult', key: 'calls' } as const, [] as CallRecord[])
const finishedAtom = atom({ plugin: 'consult', key: 'finished' } as const, [] as string[])
const tickAtom = atom({ plugin: 'consult', key: 'tick' } as const, 0)

const LABEL_WIDTH = 28
const BAR_WIDTH = 15
const BUTTONS_WIDTH = 12
// The rounded grey frame, as compact-view's band: two border columns and one
// column of padding on each side.
const FRAME_COLOR = 'inactive'
const FRAME_WIDTH = 4

function callLabel(call: CallRecord): string {
  if (call.provider === 'council') return `council · ${call.members.join(' ')}`
  const parts = [call.provider, call.model ?? 'default']
  if (call.effort !== null) parts.push(call.effort)
  return parts.join(' · ')
}

function finishedLine(done: CallRecord[], width: number): string {
  if (done.length === 1) {
    const call = done[0] as CallRecord
    const mark = call.status === 'answered' ? '✓' : '✗'
    const duration = formatDuration((call.endedAt ?? call.startedAt) - call.startedAt)
    const head = `${mark} ${call.provider} · ${call.model ?? 'default'} · ${duration}`
    return fitText(`${head} — "${call.summary}"`, width)
  }
  let answers = 0
  let errors = 0
  for (const call of done) {
    if (call.status === 'answered') answers += 1
    else errors += 1
  }
  let line = `✓ ${answers} answer${answers === 1 ? '' : 's'}`
  if (errors > 0) line += ` · ${errors} error${errors === 1 ? '' : 's'}`
  return line
}

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const calls = await read($, callsAtom)
    const finishedIds = await read($, finishedAtom)
    // Read so the drawing redraws every second while calls run.
    await read($, tickAtom)

    const running: CallRecord[] = []
    const done: CallRecord[] = []
    for (const call of calls) {
      if (call.status === 'running') running.push(call)
      else if (finishedIds.includes(call.id)) done.push(call)
    }
    if (running.length === 0 && done.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const openAnswers = () => openPaneOn($, 'answers')

    if (running.length === 0) {
      const width = Math.max(10, e.props.bodyColumns - 10 - BUTTONS_WIDTH - FRAME_WIDTH)
      return (
        <Box flexDirection="row" borderStyle="round" borderColor={FRAME_COLOR} paddingX={1}>
          <Text bold>consult  </Text>
          <Text>{finishedLine(done, width)}  </Text>
          <Button key="answers" label="Answers" onPress={openAnswers} />
        </Box>
      )
    }

    const now = await $.clock.now()
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={FRAME_COLOR} paddingX={1}>
        {running.map((call, index) => {
          const elapsed = Math.max(0, now - call.startedAt)
          const fraction = call.limitMs > 0 ? elapsed / call.limitMs : 0
          const isOver = call.provider === 'council' && elapsed > call.limitMs
          const clock = isOver ? 'over: judge retry' : `${formatClock(elapsed)} / ${formatClock(call.limitMs)}`
          return (
            <Box flexDirection="row">
              <Text bold>{index === 0 ? 'consult  ' : '         '}</Text>
              <Text wrap="truncate">{fitText(callLabel(call), LABEL_WIDTH).padEnd(LABEL_WIDTH)} </Text>
              <Text color={barColor(fraction)}>
                {progressBar(fraction, BAR_WIDTH)}
              </Text>
              <Text> {clock.padStart(13)}  </Text>
              <Button key={`cancel:${call.id}`} label="Cancel" onPress={() => cancelCall($, call.id)} />
            </Box>
          )
        })}
        <Box flexDirection="row" justifyContent="flex-end">
          <Button key="answers" label="Answers" onPress={openAnswers} />
        </Box>
      </Box>
    )
  })
}
