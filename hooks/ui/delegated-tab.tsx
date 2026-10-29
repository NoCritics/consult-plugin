import type { EngineInterface } from 'claude-code'

import type { DelegateEdits, DelegatedView, DelegateTaskRow } from '../../types'
import { fileUrl } from '../mod/files'
import {
  TABLE_ROWS,
  activeCount,
  askConfirm,
  askStopAll,
  busyText,
  buttonFor,
  cancelTask,
  confirmKindFor,
  confirmStopAll,
  confirmYes,
  dropConfirm,
  editSetting,
  hasChanges,
  isAskedAbout,
  isNotFenced,
  labelTail,
  localAtOnceSummary,
  markOf,
  openFoldOnClose,
  pressClear,
  refreshDelegated,
  saveSettings,
  selectRow,
  stateLabel,
  stopAllQuestion,
  timeLimitSummary,
  timeLimitText,
  toggleFold,
} from '../mod/delegated'
import type { RowButton } from '../mod/delegated'
import { fitStart, fitText, formatElapsed } from '../mod/format'
import { runOn, taskFolderOf } from '../mod/open'
import type { OpenAction } from '../mod/open'

// The Delegated tab of the consult pane, in three width bands. Narrow (under
// 60 columns): two lines a task, the mark, worker, title and button, then its
// state, where and time dim. Docked (60 to 99) and wide (100 and up): one line
// (mark, worker, title, state, where, time, button), the wide one with the long
// state labels and longer titles. Under the rows: the usage line, the on-close
// line, Stop all, and the settings folded into one line. Drawn from
// DelegatedView; every action goes through hooks/mod/delegated.ts.

type Table = ReturnType<EngineInterface['ui']['resolve']>

const WORKER_COLUMN = 5
// A row's mark and worker, and the gaps between its cells.
const LEAD_WIDTH = 2 + WORKER_COLUMN
const GAP = 2
const ELAPSED_COLUMN = 5
// The where cell: `copy` or `here`. Panes narrower than this leave it out,
// so the title and the state keep their room; the state label is cut last.
const WHERE_COLUMN = 4
// The first docked width: narrower panes draw two lines a task and no where cell.
const WHERE_MIN_WIDTH = 60
// From here the state labels are long and a title may be longer.
const WIDE_MIN_WIDTH = 100
// Narrower than these, a title or a state label is cut to its ellipsis.
const MIN_TITLE = 6
const MIN_STATE = 6
// A long title is cut here even in a wide pane, so the state and time stay near the name.
const MAX_TITLE = 36
const MAX_TITLE_WIDE = 48
// The detail block's indent, and its label column ("folder  ").
const DETAIL_INDENT = 4
const PATH_LABEL_WIDTH = 8
const CONFIRM_TITLE_CAP = 40
// The button's own brackets and spaces: `[ Clear ]`.
const BUTTON_CHROME = 4
const BUTTON_LABELS: Record<RowButton, string> = { cancel: 'Cancel', clear: 'Clear', discard: 'Discard' }
// What Stop all says while it runs. A row says what is going on in its state cell instead.
const STOPPING_LABEL = 'Stopping…'
// The settings' label column: the longest label, "When Claude Code closes", and a gap.
const SETTING_COLUMN = 25
const TABLE_INDENT = 2
const TABLE_LABELS: Record<(typeof TABLE_ROWS)[number], string> = { code: 'code', research_review: 'research & review', private: 'private' }
const WORKER_OPTIONS = [
  { value: 'codex', label: 'codex' },
  { value: 'agy', label: 'agy' },
  { value: 'local', label: 'local' },
  // The worker is asked for when a task of that kind comes up.
  { value: 'ask', label: 'ask' },
]
const WORKERS_EDIT_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'here', label: 'Here' },
  { value: 'copy', label: 'In a copy' },
]
const ON_CLOSE_OPTIONS = [
  { value: 'stop', label: 'Stop tasks' },
  { value: 'keep', label: 'Keep them running' },
]

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function titleOf(row: DelegateTaskRow): string {
  const title = oneLine(row.title)
  return title === '' ? 'untitled' : title
}

// The buttons under a task's details that open something: its folder, its report and its log.
// The report and the log are opened from the task's own folder (`fromTaskFolder`).
const OPEN_BUTTONS: {
  name: string
  label: string
  narrowLabel: string
  pathOf: (row: DelegateTaskRow) => string | null
  action: OpenAction
  fromTaskFolder: boolean
}[] = [
  { name: 'open-folder', label: 'Open folder', narrowLabel: 'Folder', pathOf: row => row.folder, action: 'open-folder', fromTaskFolder: false },
  { name: 'open-report', label: 'Open report', narrowLabel: 'Report', pathOf: row => row.report_path, action: 'open-text', fromTaskFolder: true },
  { name: 'show-log', label: 'Show log', narrowLabel: 'Log', pathOf: row => row.log_path, action: 'reveal', fromTaskFolder: true },
]

function lastFolderName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index] !== '') return parts[index] as string
  }
  return path
}

// A running task's age is counted from when it started, so it is right whenever the tab is drawn.
function elapsedText(row: DelegateTaskRow, now: number): string {
  let ms = row.elapsed_ms
  if (row.state === 'running' && row.started_at !== null) ms = now - row.started_at
  // A time that is not a number (a state.json that was written by hand) draws nothing.
  if (ms === null || typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  // The cell is ELAPSED_COLUMN wide: from ten hours on, whole hours ('11h'), from a hundred, whole days ('4d').
  const hours = Math.floor(ms / 3600000)
  if (hours >= 100) return `${Math.min(99, Math.floor(hours / 24))}d`
  if (hours >= 10) return `${hours}h`
  return formatElapsed(ms)
}

export function drawDelegatedTab($: EngineInterface, table: Table, surface: string, view: DelegatedView, width: number, now: number) {
  const { Box, Button, Link, Text } = table
  const shown = view.shown
  const refresh = () => refreshDelegated($)
  const errorLine = view.error !== null && <Text color="error">{view.error}</Text>

  if (shown === null) {
    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row">
          <Text dimColor>{view.status === 'error' ? '' : 'checking…  '}</Text>
          <Button key="delegated:refresh" label="Refresh" onPress={refresh} />
        </Box>
        {errorLine}
      </Box>
    )
  }

  // ---- the rows: the title gives way first, down to its minimum, then the state label ----
  const rows = shown.rows
  const isNarrow = width < WHERE_MIN_WIDTH
  const isWide = width >= WIDE_MIN_WIDTH
  // Narrow rows have their state on a second line, where the long label fits; docked rows use the short one.
  const isLongLabel = isNarrow || isWide
  const maxTitle = isWide ? MAX_TITLE_WIDE : MAX_TITLE
  // What the state cell says: a running action, or the state.
  const stateTextOf = (row: DelegateTaskRow) => {
    const doing = view.busy[row.id]
    if (doing === 'cancel' || doing === 'clear') return busyText(doing)
    return stateLabel(row, isLongLabel)
  }
  let longestTitle = MIN_TITLE
  let longestState = MIN_STATE
  let longestButton = 0
  for (const row of rows) {
    longestTitle = Math.max(longestTitle, titleOf(row).length)
    // A running action's text is cut to the cell the labels make, so it never moves the other cells.
    longestState = Math.max(longestState, stateLabel(row, isLongLabel).length)
    const button = buttonFor(row)
    if (button !== null) longestButton = Math.max(longestButton, BUTTON_LABELS[button].length + BUTTON_CHROME)
  }
  const buttonCell = longestButton === 0 ? 0 : GAP + longestButton
  let titleCell: number
  let stateCell = longestState
  if (isNarrow) {
    // Line one is mark, worker, title and button; the state, where and time are line two.
    titleCell = Math.max(MIN_TITLE, Math.min(longestTitle, width - LEAD_WIDTH - GAP - buttonCell))
  } else {
    const otherCells = LEAD_WIDTH + GAP + GAP + GAP + WHERE_COLUMN + 1 + ELAPSED_COLUMN + buttonCell
    titleCell = Math.min(longestTitle, maxTitle, width - otherCells - stateCell)
    if (titleCell < MIN_TITLE) {
      titleCell = MIN_TITLE
      stateCell = Math.max(MIN_STATE, width - otherCells - MIN_TITLE)
    }
  }

  // While its action runs a button is dim and a press does nothing (the module ignores it too).
  const drawButton = (row: DelegateTaskRow, button: RowButton) => {
    const key = `delegated:${button}:${row.id}`
    const label = BUTTON_LABELS[button]
    const isBusy = view.busy[row.id] !== undefined
    const presses: Record<RowButton, () => Promise<void>> = {
      cancel: () => cancelTask($, row.id),
      clear: () => pressClear($, row),
      discard: () => askConfirm($, row),
    }
    return <Button key={key} label={label} dimColor={isBusy} onPress={presses[button]} />
  }

  // The question under a row: Discard of a copy's work, or Clear of an in-place task.
  const drawConfirm = (row: DelegateTaskRow) => {
    const title = fitText(titleOf(row), CONFIRM_TITLE_CAP)
    const kind = confirmKindFor(row)
    let question = `Discard "${title}"? Its changes will be lost.`
    if (kind === 'conflict') question = `Discard "${title}"? Its merged changes stay in the project; the copy and its branch consult/${row.id} are removed.`
    if (kind === 'clear') question = `Clear "${title}"? Its edits stay in the project; only the task's record goes.`
    if (kind === 'unread') question = `Clear "${title}"? Claude hasn't read its result.`
    return (
      <Box flexDirection="row" paddingLeft={2}>
        {/* The buttons keep their width; on a narrow pane only the question is cut. */}
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">{question}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text>{' '.repeat(GAP)}</Text>
          <Button key={`delegated:confirm-yes:${row.id}`} label="Yes" onPress={() => confirmYes($, row.id)} />
          <Text> </Text>
          <Button key={`delegated:confirm-no:${row.id}`} label="No" onPress={() => dropConfirm($)} />
        </Box>
      </Box>
    )
  }

  // The summary is the reason when a task did not go well, so it takes the problem's colour.
  const summaryColorOf = (row: DelegateTaskRow) => {
    if (row.state === 'failed') return 'error'
    if (row.state === 'stopped' || row.state === 'paused-limit' || row.state === 'conflict') return 'warning'
    return undefined
  }

  // A path is a Link (Ctrl+click), cut from the front so the end that tells it apart stays.
  const drawPathLine = (label: string, path: string) => (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text dimColor>{label.padEnd(PATH_LABEL_WIDTH)}</Text>
      </Box>
      <Link href={fileUrl(path)} label={fitStart(path, width - DETAIL_INDENT - PATH_LABEL_WIDTH)} />
    </Box>
  )

  const drawDetails = (row: DelegateTaskRow) => {
    const lines = []
    // A docked row drew the short label: what it dropped is said here, before the summary.
    const tail = isLongLabel ? '' : labelTail(row)
    const summary = [tail, oneLine(row.summary ?? '')].filter(part => part !== '').join(' · ')
    if (summary !== '') {
      const color = summaryColorOf(row)
      lines.push(<Text color={color} dimColor={color === undefined} wrap="truncate-end">{summary}</Text>)
    }
    if (row.folder !== null) lines.push(drawPathLine('folder', row.folder))
    if (row.log_path !== null) lines.push(drawPathLine('log', row.log_path))
    const openButtons = []
    for (const [index, open] of OPEN_BUTTONS.entries()) {
      const path = open.pathOf(row)
      if (path === null) continue
      openButtons.push(
        <Box key={`delegated:${open.name}-box:${row.id}`} flexShrink={0}>
          <Button key={`delegated:${open.name}:${row.id}`} label={isNarrow ? open.narrowLabel : open.label} onPress={async () => runOn($, path, open.action, open.fromTaskFolder ? await taskFolderOf($, row.id) : undefined)} />
          {index < OPEN_BUTTONS.length - 1 && <Text>  </Text>}
        </Box>,
      )
    }
    if (openButtons.length > 0) lines.push(<Box flexDirection="row">{openButtons}</Box>)
    const notes: string[] = []
    if (isNotFenced(row)) notes.push('not fenced')
    if (row.worker === 'agy') notes.push("can't run commands")
    if (row.worker === 'local' && row.state === 'running' && row.keep_running) notes.push('keeps the GPU busy and its model loaded')
    if (notes.length > 0) lines.push(<Text color="warning" wrap="truncate-end">{notes.join(' · ')}</Text>)
    return (
      <Box flexDirection="column" paddingLeft={DETAIL_INDENT}>
        {lines}
      </Box>
    )
  }

  const drawRow = (row: DelegateTaskRow) => {
    const { mark, color } = markOf(row)
    const button = buttonFor(row)
    const isSelected = view.selectedId === row.id
    const title = fitText(titleOf(row), titleCell).padEnd(titleCell)
    const stateText = stateTextOf(row)
    const isBusy = view.busy[row.id] !== undefined
    const labelColor = !isBusy && (color === 'warning' || color === 'error') ? color : undefined
    // Under the row, in both layouts: the question it asks, and its details when it is open.
    const confirmNode = view.confirm !== null && isAskedAbout(view.confirm, row) && drawConfirm(row)
    const detailsNode = isSelected && drawDetails(row)
    // The worker and the title are one press: the task's name opens its details.
    const name = (
      <Button key={`delegated:row:${row.id}`} plain onPress={() => selectRow($, row.id)}>
        {row.worker.padEnd(WORKER_COLUMN)}
        {' '.repeat(GAP)}
        <Text bold={isSelected}>{title}</Text>
      </Button>
    )
    const buttonCellOf = () =>
      button === null ? null : (
        <Box flexShrink={0}>
          <Text>{' '.repeat(GAP)}</Text>
          {drawButton(row, button)}
        </Box>
      )
    if (isNarrow) {
      // Where it ran and the time keep their width; a long state label ("conflict · src/auth.ts") is the part cut.
      const secondLine = [row.location === 'copy' ? 'in a copy' : 'here']
      const elapsed = elapsedText(row, now)
      if (elapsed !== '') secondLine.push(elapsed)
      return (
        <Box flexDirection="column">
          <Box key={`delegated:line:${row.id}`} flexDirection="row">
            <Box flexShrink={0}>
              <Text color={color}>{mark} </Text>
              {name}
            </Box>
            {buttonCellOf()}
          </Box>
          <Box paddingLeft={DETAIL_INDENT}>
            <Box flexShrink={1} minWidth={0}>
              <Text color={labelColor} dimColor={labelColor === undefined} wrap="truncate-end">{stateText}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={labelColor} dimColor={labelColor === undefined}>{` · ${secondLine.join(' · ')}`}</Text>
            </Box>
          </Box>
          {confirmNode}
          {detailsNode}
        </Box>
      )
    }
    const label = fitText(stateText, stateCell).padEnd(stateCell)
    return (
      <Box flexDirection="column">
        {/* Every cell has its width: a narrow row cuts the title, never wraps. */}
        <Box key={`delegated:line:${row.id}`} flexDirection="row">
          <Box flexShrink={0}>
            <Text color={color}>{mark} </Text>
            {name}
          </Box>
          <Box flexShrink={0}>
            <Text color={labelColor} dimColor={labelColor === undefined && (color === 'inactive' || isBusy)}>{`${' '.repeat(GAP)}${label}`}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{`${' '.repeat(GAP)}${row.location.padEnd(WHERE_COLUMN)}`}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{` ${elapsedText(row, now).padStart(ELAPSED_COLUMN)}`}</Text>
          </Box>
          {buttonCellOf()}
        </Box>
        {confirmNode}
        {detailsNode}
      </Box>
    )
  }

  // ---- under the rows ----
  const usageLines = []
  const okWorkers: string[] = []
  for (const worker of Object.keys(shown.limits)) {
    const limit = shown.limits[worker]
    if (limit === undefined) continue
    if (limit.note === '') {
      okWorkers.push(`${worker} ok`)
      continue
    }
    usageLines.push(<Text color={limit.level === 'full' ? 'error' : 'warning'}>{limit.note}</Text>)
  }
  if (okWorkers.length > 0) usageLines.push(<Text dimColor>{okWorkers.join(' · ')}</Text>)

  const elsewhereLines = []
  for (const other of shown.elsewhere) {
    if (other.finished === 0) continue
    const noun = other.finished === 1 ? 'task' : 'tasks'
    elsewhereLines.push(
      <Text dimColor wrap="truncate-end">
        {`${other.finished} ${noun} finished in ${lastFolderName(other.project)}; open a session there to merge`}
      </Text>,
    )
  }

  const settings = shown.settings
  const activeTasks = activeCount(shown)
  const isKeeping = settings.on_close === 'keep'
  let onCloseText = isKeeping ? 'Tasks keep running after Claude Code closes' : 'Tasks stop when Claude Code closes'
  if (isNarrow) onCloseText = isKeeping ? 'On close: tasks keep running' : 'On close: tasks stop'

  // ---- the settings, folded into one line ----
  let settingsBlock = null
  if (surface !== 'mobile' && 'Select' in table && 'Input' in table) {
    const { Input, Select } = table
    const edits: DelegateEdits = view.edits
    let workersEditName = settings.workers_edit as string
    for (const option of WORKERS_EDIT_OPTIONS) {
      if (option.value === settings.workers_edit) workersEditName = option.label
    }
    const summary = `workers edit ${workersEditName} · table · local at once ${localAtOnceSummary(settings)} · limit ${timeLimitSummary(settings.time_limit_min)}`
    if (!view.isFoldOpen) {
      settingsBlock = (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Button key="delegated:fold" plain label="▸ Settings" onPress={() => toggleFold($)} />
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">{`  ${summary}`}</Text>
          </Box>
        </Box>
      )
    } else {
      const tableSelects = []
      for (const row of TABLE_ROWS) {
        const options = [...WORKER_OPTIONS]
        if (settings.table[row] === 'mixed') options.push({ value: 'mixed', label: 'mixed' })
        tableSelects.push(
          <Select
            key={`delegated:set:table:${row}`}
            label={`${' '.repeat(TABLE_INDENT)}${TABLE_LABELS[row].padEnd(SETTING_COLUMN - TABLE_INDENT)}`}
            options={options}
            value={edits[row] ?? settings.table[row]}
            onSelect={value => editSetting($, row, value)}
          />,
        )
      }
      settingsBlock = (
        <Box flexDirection="column">
          <Button key="delegated:fold" plain label="▾ Settings" onPress={() => toggleFold($)} />
          <Box flexDirection="column" paddingLeft={2}>
            <Select
              key="delegated:set:workers_edit"
              label={'Workers edit'.padEnd(SETTING_COLUMN)}
              options={WORKERS_EDIT_OPTIONS}
              value={edits.workers_edit ?? settings.workers_edit}
              onSelect={value => editSetting($, 'workers_edit', value)}
            />
            <Text dimColor>Who does what, by kind of task</Text>
            {tableSelects}
            <Input
              key="delegated:set:local_at_once"
              label={'Local at once'.padEnd(SETTING_COLUMN)}
              placeholder="auto or a number"
              value={edits.local_at_once ?? String(settings.local_at_once)}
              onInput={text => editSetting($, 'local_at_once', text)}
              onSubmit={text => editSetting($, 'local_at_once', text)}
            />
            {settings.local_at_once === 'auto' && typeof settings.local_slots === 'number' && (
              <Text dimColor>{`auto is ${settings.local_slots} at once right now`}</Text>
            )}
            <Select
              key="delegated:set:on_close"
              label={'When Claude Code closes'.padEnd(SETTING_COLUMN)}
              options={ON_CLOSE_OPTIONS}
              value={edits.on_close ?? settings.on_close}
              onSelect={value => editSetting($, 'on_close', value)}
            />
            <Input
              key="delegated:set:time_limit"
              label={'Time limit'.padEnd(SETTING_COLUMN)}
              placeholder="minutes, or 3h"
              value={edits.time_limit ?? timeLimitText(settings.time_limit_min)}
              onInput={text => editSetting($, 'time_limit', text)}
              onSubmit={text => editSetting($, 'time_limit', text)}
            />
            <Box flexDirection="row">
              <Button key="delegated:save" label="Save" dimColor={!hasChanges(view)} onPress={() => saveSettings($)} />
              {view.savedMessage !== null && <Text color="success">{`  ${view.savedMessage}`}</Text>}
            </Box>
          </Box>
        </Box>
      )
    }
  }

  return (
    <Box flexDirection="column" width={width}>
      {errorLine}
      {rows.length === 0 && <Text dimColor wrap="wrap">No delegated tasks yet. Ask Claude to hand a task to Codex, agy or a local model.</Text>}
      {rows.map(row => drawRow(row))}
      {/* Narrow, the focus ring and the pointer invert the task's name: that is the hint. */}
      {rows.length > 0 && !isNarrow && view.selectedId === null && <Text dimColor>press a task for its summary, folder and log</Text>}
      <Text> </Text>
      {view.confirm !== null && view.confirm.kind === 'stop-all' ? (
        <Box flexDirection="row">
          <Box flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">{stopAllQuestion(shown)}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text>{' '.repeat(GAP)}</Text>
            <Button key="delegated:stop-all-yes" label="Yes" onPress={() => confirmStopAll($)} />
            <Text>{' '.repeat(GAP)}</Text>
            <Button key="delegated:stop-all-no" label="No" onPress={() => dropConfirm($)} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row">
          {activeTasks > 0 && (
            <Button
              key="delegated:stop-all"
              label={view.busy['stop-all'] === undefined ? `Stop all (${activeTasks})` : STOPPING_LABEL}
              dimColor={view.busy['stop-all'] !== undefined}
              onPress={() => askStopAll($)}
            />
          )}
          {activeTasks > 0 && <Text>  </Text>}
          <Button key="delegated:refresh" label="Refresh" onPress={refresh} />
        </Box>
      )}
      {usageLines}
      {/* The separator lives with the button, so "change" is never glued to the sentence. */}
      <Box flexDirection="row">
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">{onCloseText}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{' · '}</Text>
          <Button key="delegated:on-close-change" plain label="change" onPress={() => openFoldOnClose($)} />
        </Box>
      </Box>
      {shown.git.declined && <Text dimColor>no git here · workers edit in place</Text>}
      {elsewhereLines}
      {settingsBlock !== null && <Text> </Text>}
      {settingsBlock}
    </Box>
  )
}
