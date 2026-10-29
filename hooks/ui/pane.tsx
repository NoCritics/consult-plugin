import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, UiCopyArgs } from 'claude-code'

import type { CallRecord, CouncilInfo, ImageRef, PaneTab } from '../../types'
import { fileName, fileUrl, isImagePath, isSafePath, platformOf } from '../mod/files'
import type { Platform } from '../mod/files'
import { formatDuration } from '../mod/format'
import { serviceMark } from '../mod/health'
import { readHistory } from '../mod/history'
import { openDelegated } from '../mod/delegated'
import { runOn } from '../mod/open'
import { LOCAL_RUNNERS, openLocal, refreshLocal } from '../mod/local-setup'
import { INITIAL_DELEGATED, INITIAL_HEALTH, INITIAL_LOCAL, INITIAL_PANE, PANE_ID } from '../mod/state'
import { drawDelegatedTab } from './delegated-tab'
import { drawLocalTab } from './local-tab'

// The consult pane: this session's calls and earlier sessions' history, one
// entry expanded at a time, with Copy buttons and, for images, Open / Show in
// folder / Copy path. Opened only when asked: /consult or the band's Answers.
// The calls made for one prompt share a rounded box headed by the question,
// their answers parted by a rule.

export { PANE_ID }
// The tab last used, kept across sessions.
const TAB_STORE_KEY = 'pane-tab'
const TABS: { tab: PaneTab; label: string }[] = [
  { tab: 'answers', label: 'Answers' },
  { tab: 'local', label: 'Local models' },
  { tab: 'delegated', label: 'Delegated' },
]
const COMMANDS = ['consult', 'consult-answers']
const PAGE = 10
const IMAGE_COLUMNS = 24
const IMAGE_ROWS = 12
const GROUP_COLOR = 'inactive'
// A group box's border and padding: two columns on each side.
const GROUP_FRAME_WIDTH = 4

const callsAtom = atom({ plugin: 'consult', key: 'calls' } as const, [] as CallRecord[])
const healthAtom = atom({ plugin: 'consult', key: 'health' } as const, INITIAL_HEALTH)
const paneAtom = atom({ plugin: 'consult', key: 'pane' } as const, INITIAL_PANE)
const localAtom = atom({ plugin: 'consult', key: 'local' } as const, INITIAL_LOCAL)
const delegatedAtom = atom({ plugin: 'consult', key: 'delegated' } as const, INITIAL_DELEGATED)

type PaneEntry = {
  id: string
  tool: string
  provider: string
  model: string | null
  status: CallRecord['status']
  startedAt: number
  durationMs: number | null
  summary: string
  answer: string
  answerTruncated: boolean
  prompt: string
  images: ImageRef[]
  council: CouncilInfo | null
  turnStartedAt: number | null
}

// Shows `tab` and remembers it as the tab last used.
async function selectTab($: EngineInterface, tab: PaneTab): Promise<void> {
  await update($, paneAtom, view => ({ ...view, tab }))
  await $.store.set(TAB_STORE_KEY, tab)
  if (tab === 'local') await openLocal($)
  // Not awaited: the tab shows "checking…" while the script runs.
  if (tab === 'delegated') void openDelegated($).catch(() => undefined)
}

export async function openPaneOn($: EngineInterface, tab: PaneTab): Promise<void> {
  await selectTab($, tab)
  await $.ui.open({ id: PANE_ID, title: 'consult', focus: true, closeOnEscape: true })
}

// /consult:setlocal: the Local models tab, read afresh (for the runner
// named, if it is one).
// false when no surface placed the pane: the chat steps run instead.
async function openSetup($: EngineInterface, args: string): Promise<boolean> {
  await update($, paneAtom, view => ({ ...view, tab: 'local' as const }))
  await $.store.set(TAB_STORE_KEY, 'local')
  const opened = await $.ui.open({ id: PANE_ID, title: 'consult', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) return false
  const named = args.trim()
  let runner: string | null = null
  for (const one of LOCAL_RUNNERS) {
    if (one === named) runner = one
  }
  // Not awaited: the pane shows "checking…" while the script runs.
  void refreshLocal($, runner)
  return true
}

async function lastUsedTab($: EngineInterface): Promise<PaneTab> {
  const stored = await $.store.get(TAB_STORE_KEY)
  for (const one of TABS) {
    if (one.tab === stored) return one.tab
  }
  return 'answers'
}

async function togglePane($: EngineInterface): Promise<void> {
  for (const pane of await $.ui.panes()) {
    if (pane.id === PANE_ID) {
      await $.ui.close({ id: PANE_ID })
      return
    }
  }
  await openPaneOn($, await lastUsedTab($))
}

async function toggleEntry($: EngineInterface, id: string): Promise<void> {
  await update($, paneAtom, view => ({ ...view, expandedId: view.expandedId === id ? null : id }))
}

async function showMore($: EngineInterface, list: 'session' | 'earlier'): Promise<void> {
  await update($, paneAtom, view =>
    list === 'session' ? { ...view, sessionShown: view.sessionShown + PAGE } : { ...view, earlierShown: view.earlierShown + PAGE },
  )
}

// The clipboard shows nothing by itself: a toast says the copy took, or why not.
async function copyWithToast($: EngineInterface, text: string, surface: UiCopyArgs['surface'], what: string): Promise<void> {
  const copied = await $.ui.copy({ text, surface })
  if (copied.isCopied) {
    $.ui.toast(`consult: ${what} copied`)
    return
  }
  $.ui.toast(`consult: could not copy the ${what} (${copied.reason})`)
}

function clockTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function dayAndTime(ms: number): string {
  const at = new Date(ms)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${clockTime(ms)}`
}

function entryTitle(entry: PaneEntry): string {
  if (entry.council !== null) {
    return entry.council.tied ? 'council · tie' : `council · winner ${entry.council.winner ?? '?'}`
  }
  if (entry.tool === 'agy_generate_image' || entry.tool === 'codex_generate_image') return `${entry.provider} image`
  return `${entry.provider} · ${entry.model ?? 'default'}`
}

function statusMark(entry: PaneEntry): string {
  if (entry.status === 'running') return '⋯'
  if (entry.status === 'answered') return '✓'
  if (entry.status === 'cancelled') return '–'
  return '✗'
}

function imageAlt(image: ImageRef): string {
  const size = image.width !== null && image.height !== null ? ` · ${image.width}×${image.height}` : ''
  return `${fileName(image.path)}${size} · ${Math.round(image.bytes / 1024)} KB`
}

function fromRecord(call: CallRecord): PaneEntry {
  return {
    ...call,
    durationMs: call.endedAt === null ? null : call.endedAt - call.startedAt,
  }
}

// The entries, in order, cut into the groups of one prompt each: same session
// and same prompt time. History from before prompt times were kept groups by
// session and identical prompt text instead: the calls of one ask got one.
function groupByPrompt(entries: PaneEntry[], sessionOf: (entry: PaneEntry) => string): PaneEntry[][] {
  const groups: PaneEntry[][] = []
  const groupIndexByKey = new Map<string, number>()
  for (const entry of entries) {
    const key =
      entry.turnStartedAt === null ? `${sessionOf(entry)}:prompt:${entry.prompt}` : `${sessionOf(entry)}:turn:${entry.turnStartedAt}`
    const index = groupIndexByKey.get(key)
    if (index === undefined) {
      groupIndexByKey.set(key, groups.length)
      groups.push([entry])
    } else {
      ;(groups[index] as PaneEntry[]).push(entry)
    }
  }
  return groups
}

// The question a group answers: the first line of its first call's prompt.
function questionOf(group: PaneEntry[]): string {
  const first = group[group.length - 1] as PaneEntry
  for (const line of first.prompt.split('\n')) {
    if (line.trim() !== '') return line.trim()
  }
  return ''
}

// Called from register.tsx's session.start hook: /consult, or
// /consult-answers when Claude Code refuses the first name.
export async function registerConsultCommand($: EngineInterface): Promise<void> {
  for (const name of COMMANDS) {
    try {
      await $.command.register({ name, description: 'Show consult calls and answers', immediate: true })
      return
    } catch {
      // taken: try the next name
    }
  }
}

export function registerPane(on: On): void {
  on('command.run', { command: 'consult' }, async $ => {
    await togglePane($)
    // No text: an empty one still draws "consult: " in the transcript.
    return {}
  }).catch(() => ({ text: 'consult: the pane could not open.' }))

  on('command.run', { command: 'consult-answers' }, async $ => {
    await togglePane($)
    // No text: an empty one still draws "consult: " in the transcript.
    return {}
  }).catch(() => ({ text: 'consult: the pane could not open.' }))

  // The plugin's /consult:setlocal walks through setup in chat; typed at the
  // prompt in Claude Code, the pane's Local models tab does it instead. From
  // anywhere else, or when the pane can't open, the chat steps run.
  on('command.run', { command: 'consult:setlocal' }, async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    if (!(await openSetup($, e.args))) return next(e)
    // No text: an empty one still draws "consult: " in the transcript.
    return {}
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = table
    const view = await read($, paneAtom)
    const health = await read($, healthAtom)
    const calls = await read($, callsAtom)
    const history = await readHistory($)
    const width = Math.max(20, e.props.bodyColumns)
    const platform: Platform = await platformOf($)

    const sessionIds: string[] = []
    const session: PaneEntry[] = []
    for (let index = calls.length - 1; index >= 0; index--) {
      const call = calls[index] as CallRecord
      sessionIds.push(call.id)
      session.push(fromRecord(call))
    }
    const earlier: PaneEntry[] = []
    const sessionIdOf = new Map<string, string>()
    for (const entry of history) {
      if (!sessionIds.includes(entry.id)) {
        earlier.push(entry)
        sessionIdOf.set(entry.id, entry.sessionId)
      }
    }
    const sessionGroups = groupByPrompt(session, () => 'this')
    const earlierGroups = groupByPrompt(earlier, entry => sessionIdOf.get(entry.id) ?? '')

    const drawEntry = (entry: PaneEntry, isEarlier: boolean) => {
      const isOpen = view.expandedId === entry.id
      const duration = entry.durationMs === null ? 'running' : formatDuration(entry.durationMs)
      const when = isEarlier ? dayAndTime(entry.startedAt) : clockTime(entry.startedAt)
      const label = `${isOpen ? '▾' : '▸'} ${statusMark(entry)} ${entryTitle(entry)} · ${duration} · ${when}`
      return (
        <Box flexDirection="column">
          <Button key={`entry:${entry.id}`} plain label={label} onPress={() => toggleEntry($, entry.id)} />
          {!isOpen && entry.summary !== '' && (
            <Text dimColor wrap="truncate">
              {'    '}
              {entry.summary}
            </Text>
          )}
          {isOpen && (
            <Box flexDirection="column" paddingLeft={4}>
              {entry.images.map((image, n) => (
                <Box flexDirection="column">
                  {isImagePath(platform, image.path) ? (
                    <Link href={fileUrl(image.path)} label={fileUrl(image.path)} />
                  ) : (
                    <Text dimColor>{image.path}</Text>
                  )}
                  <Box flexDirection="row">
                    {isImagePath(platform, image.path) && (
                      <Button key={`open:${entry.id}:${n}`} label="Open" onPress={() => runOn($, image.path, 'open')} />
                    )}
                    {isImagePath(platform, image.path) && <Text> </Text>}
                    {isSafePath(platform, image.path) && (
                      <Button key={`reveal:${entry.id}:${n}`} label="Show in folder" onPress={() => runOn($, image.path, 'reveal')} />
                    )}
                    {isSafePath(platform, image.path) && <Text> </Text>}
                    <Button
                      key={`copy-path:${entry.id}:${n}`}
                      label="Copy path"
                      onPress={press => copyWithToast($, image.path, press.surface, 'path')}
                    />
                  </Box>
                  {'Image' in table && image.path.toLowerCase().endsWith('.png') ? (
                    <table.Image source={{ file: image.path, format: 'png' }} columns={IMAGE_COLUMNS} rows={IMAGE_ROWS} alt={imageAlt(image)} />
                  ) : (
                    <Text dimColor>{imageAlt(image)}</Text>
                  )}
                </Box>
              ))}
              {entry.answer !== '' && entry.images.length === 0 && <Markdown text={entry.answer} />}
              {entry.answerTruncated && <Text dimColor>(answer cut at 32 KB)</Text>}
              <Box flexDirection="row">
                {entry.answer !== '' && (
                  <Button
                    key={`copy-answer:${entry.id}`}
                    label="Copy answer"
                    onPress={press => copyWithToast($, entry.answer, press.surface, 'answer')}
                  />
                )}
                <Text> </Text>
                <Button
                  key={`copy-prompt:${entry.id}`}
                  label="Copy prompt"
                  onPress={press => copyWithToast($, entry.prompt, press.surface, 'prompt')}
                />
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const drawGroup = (group: PaneEntry[], isEarlier: boolean) => {
      const question = questionOf(group)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={GROUP_COLOR} paddingX={1}>
          {question !== '' && (
            <Text dimColor wrap="truncate">
              “{question}”
            </Text>
          )}
          {group.map((entry, index) => (
            <Box flexDirection="column">
              {index > 0 && <Text dimColor>{'─'.repeat(Math.max(1, width - GROUP_FRAME_WIDTH))}</Text>}
              {drawEntry(entry, isEarlier)}
            </Box>
          ))}
        </Box>
      )
    }

    const services = health.services
    const tabBar = (
      <Box flexDirection="row">
        {TABS.map(one => (
          <Box flexDirection="row">
            <Button
              key={`tab:${one.tab}`}
              plain
              label={view.tab === one.tab ? `[${one.label}]` : one.label}
              dimColor={view.tab !== one.tab}
              onPress={() => selectTab($, one.tab)}
            />
            <Text>  </Text>
          </Box>
        ))}
      </Box>
    )
    if (view.tab === 'local') {
      return (
        <Box flexDirection="column" width={width}>
          {tabBar}
          <Text> </Text>
          {drawLocalTab($, table, e.surface, await read($, localAtom), width)}
        </Box>
      )
    }
    if (view.tab === 'delegated') {
      return (
        <Box flexDirection="column" width={width}>
          {tabBar}
          <Text> </Text>
          {drawDelegatedTab($, table, e.surface, await read($, delegatedAtom), width, await $.clock.now())}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width={width}>
        {tabBar}
        <Text> </Text>
        <Text>
          codex {serviceMark(services.codex)}  agy {serviceMark(services.agy)}  local {serviceMark(services.local)}
        </Text>
        <Text> </Text>
        <Text bold>This session</Text>
        {session.length === 0 && <Text dimColor>No consult calls yet.</Text>}
        {sessionGroups.slice(0, view.sessionShown).map(group => drawGroup(group, false))}
        {sessionGroups.length > view.sessionShown && <Button key="more-session" label="Show 10 more" onPress={() => showMore($, 'session')} />}
        {earlier.length > 0 && <Text> </Text>}
        {earlier.length > 0 && <Text bold>Earlier sessions</Text>}
        {earlierGroups.slice(0, view.earlierShown).map(group => drawGroup(group, true))}
        {earlierGroups.length > view.earlierShown && <Button key="more-earlier" label="Show 10 more" onPress={() => showMore($, 'earlier')} />}
      </Box>
    )
  })
}
