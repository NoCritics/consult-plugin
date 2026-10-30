import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

import type { RanResult } from './fixtures/results'

// Everything beneath the consult mod in a test: the clock, the store, the
// files and environment its settings come from, and the UI and tools it
// calls. Each call it answers is recorded in `seen`.

// The engine checks an Image's file against the host's own path rules, so the
// tests' Windows image paths can be drawn only on a Windows host. The host shows
// in the real path the mod read its defaults from; with no such read yet, Windows.
export function onWindowsHost(w: World): boolean {
  for (const path of w.seen.reads) {
    if (path.endsWith('mcp/lib/defaults.json')) return /^[A-Za-z]:\//.test(path)
  }
  return true
}

export const PLUGIN = 'consult'
export const CONSULT = 'mcp__plugin_consult_consult__'

export type Seen = {
  toasts: string[]
  statuses: (string | undefined)[]
  notifies: string[]
  pushes: string[]
  taskStops: string[]
  copies: string[]
  opened: string[]
  closed: string[]
  registered: string[]
  processes: string[][]
  healthRuns: { argv: string[]; cwd: string | undefined }[]
  setlocalRuns: { argv: string[]; cwd: string | undefined }[]
  delegateRuns: { argv: string[]; cwd: string | undefined; timeoutMs: number | undefined }[]
  // the text of each row $.session.append added
  appended: string[]
  mcpCalls: { server: string; tool: string }[]
  modelPrompts: string[]
  // the text of each prompt the mod itself submitted ($.prompt.submit, origin plugin)
  submitted: string[]
  // every path $.fs.read was asked for, slashes forward
  reads: string[]
}

export type WorldOptions = {
  now?: number
  cwd?: string
  sessionId?: string
  // consult.local.md texts by path ('C:/proj/.claude/consult.local.md', ...)
  files?: Record<string, string>
  // folders fs.stat reports as directories (a path in `files` is a file)
  dirs?: string[]
  // where fs.stat's realPath lands for a path, when it is not the path itself (a link out of a folder)
  realPaths?: Record<string, string>
  store?: Record<string, unknown>
  env?: Record<string, string>
  // command names command.register refuses
  refuseCommands?: string[]
  // panes ui.panes reports as open
  openPanes?: string[]
  // ui.open throws
  openThrows?: boolean
  // ui.open answers that no surface placed the pane
  openNotPlaced?: boolean
  modelReply?: string
  // what hooks/scripts/health.js prints: each service's status body, or
  // 'hang' (never exits), 'throw' (cannot start) or raw stdout text
  healthScript?: Record<string, unknown> | 'hang' | 'throw' | { stdout: string; exitCode: number }
  // what hooks/scripts/setlocal.js prints for its arguments after the project
  // (['show'], ['preview', json], ...): an object (printed as JSON), 'hang',
  // 'throw', or raw stdout and exit code
  setlocal?: (args: string[]) => unknown | Promise<unknown>
  // what hooks/scripts/delegate.js prints for its arguments after the project
  // (['show'], ['cancel', id], ['clear', id, json], ...), as setlocal does
  delegate?: (args: string[]) => unknown | Promise<unknown>
  // fs.read of defaults.json throws
  defaultsThrow?: boolean
  // env.get throws: a fault the mod does not catch itself
  envThrows?: boolean
  // store.get answers only after this long on the mock clock
  storeGetDelayMs?: number
  // how a TaskStop call ends: stopped (default), refused by the permission
  // check, or stopped after 10 s on the mock clock (a permission prompt open)
  taskStop?: 'stopped' | 'refused' | 'slow'
  // how a copy ends: copied (default) or no-clipboard
  copy?: 'copied' | 'no-clipboard'
  // how ui.notify ends: sent (default), refused with no-channel (as on this
  // machine) or never answering
  notify?: 'sent' | 'no-channel' | 'hang'
  // the session's project root, when it differs from the working directory
  // (a Bash cd moved the cwd); default: the cwd
  root?: string
  // runs before each store.get answers, to change the store as another session would
  beforeStoreGet?: (key: string, store: Record<string, unknown>) => void
}

export type World = { clock: MockClock; seen: Seen; files: Record<string, string>; state: Record<string, unknown>; store: Record<string, unknown> }

export const DEFAULTS_JSON = JSON.stringify({
  timeout_ms: 180000,
  codex_timeout_floor_ms: 600000,
  agy_image_timeout_ms: 300000,
  codex_image_timeout_ms: 300000,
  notify_after_s: 120,
  history_size: 50,
  local_slow_floor_ms: 1200000,
})

// The tests' paths are Windows paths ('C:/proj/...'). On Linux and macOS they are
// relative, so the engine resolves them under the real working directory before
// a hook sees them: what stands before the drive letter is dropped.
function slashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*\/(?=[A-Za-z]:\/)/, '')
}

export function world(on: On, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: options.now ?? 1_000_000 })
  if (options.envThrows) {
    on('env.get', () => {
      throw new Error('env unavailable')
    })
  } else {
    mock.env(on, options.env ?? { USERPROFILE: 'C:/Users/me', OS: 'Windows_NT' })
  }
  const files: Record<string, string> = { ...(options.files ?? {}) }
  const seen: Seen = {
    toasts: [],
    statuses: [],
    notifies: [],
    pushes: [],
    taskStops: [],
    copies: [],
    opened: [],
    closed: [],
    registered: [],
    processes: [],
    healthRuns: [],
    setlocalRuns: [],
    delegateRuns: [],
    appended: [],
    mcpCalls: [],
    modelPrompts: [],
    submitted: [],
    reads: [],
  }
  const openPanes = [...(options.openPanes ?? [])]
  // The mod's $.state as last written: the test's state.set hook sits beneath it.
  const state: Record<string, unknown> = {}
  // The mod's $.store, in memory, readable by the test.
  const store: Record<string, unknown> = { ...(options.store ?? {}) }
  on('store.get', async ($, e) => {
    if (options.storeGetDelayMs) await clock.sleep(options.storeGetDelayMs)
    options.beforeStoreGet?.(e.key, store)
    return { value: store[e.key] }
  })
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('state.set', ($, e, next) => {
    if (e.plugin === PLUGIN) state[e.key] = e.value
    return next(e)
  })

  // The engine's own answers beneath the mod for the events it hooks.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('command.run', () => ({ text: '(no such command)' }))
  on('session.cwd', () => ({ value: options.cwd ?? 'C:/proj' }))
  on('session.root', () => ({ value: options.root ?? options.cwd ?? 'C:/proj' }))
  on('session.id', () => ({ value: options.sessionId ?? 'session-1' }))
  on('fs.exists', ($, e) => ({ value: slashes(e.path) in files || slashes(e.path).endsWith('mcp/lib/defaults.json') }))
  on('fs.stat', ($, e) => {
    const path = slashes(e.path)
    const kind = (options.dirs ?? []).includes(path) ? 'dir' : path in files ? 'file' : null
    if (kind === null) throw new Error(`ENOENT: ${path}`)
    return { value: { kind, size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: options.realPaths?.[path] ?? path } : {}) } }
  })
  on('fs.read', ($, e) => {
    const path = slashes(e.path)
    seen.reads.push(path)
    if (path.endsWith('mcp/lib/defaults.json')) {
      if (options.defaultsThrow) throw new Error('EACCES: defaults.json')
      return { value: DEFAULTS_JSON }
    }
    const text = files[path]
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return { value: text }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', ($, e) => {
    seen.notifies.push(e.text)
    if (options.notify === 'hang') return new Promise<never>(() => {})
    if (options.notify === 'no-channel') return { value: { isSent: false as const, reason: 'no-channel' as const } }
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.copy', ($, e) => {
    seen.copies.push(e.text)
    if (options.copy === 'no-clipboard') return { value: { isCopied: false, reason: 'no-clipboard' } }
    return { value: { isCopied: true } }
  })
  on('ui.open', ($, e) => {
    if (options.openThrows) throw new Error('no surface to open a pane on')
    seen.opened.push(e.id)
    if (!openPanes.includes(e.id)) openPanes.push(e.id)
    if (options.openNotPlaced) return { value: { isPlaced: false as const, reason: 'no surface attached' } }
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    const at = openPanes.indexOf(e.id)
    if (at >= 0) openPanes.splice(at, 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: openPanes.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('command.register', ($, e) => {
    if ((options.refuseCommands ?? []).includes(e.name)) throw new Error(`command name taken: ${e.name}`)
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('process.run', async ($, e) => {
    if (slashes(e.argv[1] ?? '').endsWith('hooks/scripts/health.js')) {
      seen.healthRuns.push({ argv: [...e.argv], cwd: e.init?.cwd })
      const script = options.healthScript ?? {}
      if (script === 'hang') return new Promise<never>(() => {})
      if (script === 'throw') throw new Error('spawn node ENOENT')
      const printed = 'stdout' in script && typeof script.stdout === 'string' ? (script as { stdout: string; exitCode: number }) : { stdout: JSON.stringify(script), exitCode: 0 }
      return { value: { exitCode: printed.exitCode, stdout: printed.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (slashes(e.argv[1] ?? '').endsWith('hooks/scripts/setlocal.js')) {
      seen.setlocalRuns.push({ argv: [...e.argv], cwd: e.init?.cwd })
      const answer = options.setlocal ? await options.setlocal(e.argv.slice(3)) : { error: 'no setlocal answer in this test' }
      if (answer === 'hang') return new Promise<never>(() => {})
      if (answer === 'throw') throw new Error('spawn node ENOENT')
      const raw = answer as { stdout?: unknown; exitCode?: unknown }
      const printed = typeof raw.stdout === 'string' && typeof raw.exitCode === 'number' ? { stdout: raw.stdout, exitCode: raw.exitCode } : { stdout: `${JSON.stringify(answer)}\n`, exitCode: 0 }
      return { value: { exitCode: printed.exitCode, stdout: printed.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (slashes(e.argv[1] ?? '').endsWith('hooks/scripts/delegate.js')) {
      seen.delegateRuns.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
      const answer = options.delegate ? await options.delegate(e.argv.slice(3)) : { error: 'no delegate answer in this test' }
      if (answer === 'hang') return new Promise<never>(() => {})
      if (answer === 'throw') throw new Error('spawn node ENOENT')
      const raw = answer as { stdout?: unknown; exitCode?: unknown }
      const printed = typeof raw.stdout === 'string' && typeof raw.exitCode === 'number' ? { stdout: raw.stdout, exitCode: raw.exitCode } : { stdout: `${JSON.stringify(answer)}\n`, exitCode: 0 }
      return { value: { exitCode: printed.exitCode, stdout: printed.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    seen.processes.push([...e.argv])
    return { value: { exitCode: e.argv[0] === 'explorer.exe' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.append', ($, e, next) => {
    const parts: string[] = []
    for (const block of e.message.content as { type: string; text?: string }[]) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    seen.appended.push(parts.join(''))
    return next(e)
  })
  on('model.complete', ($, e) => {
    seen.modelPrompts.push(e.prompt)
    return { value: { isAnswered: true, text: options.modelReply ?? 'A haiku summary.', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  // $.mcp.call goes through the permission check (auto mode refuses it), so
  // the mod must never use it: any call is recorded and fails.
  on('mcp.call', ($, e) => {
    seen.mcpCalls.push({ server: e.server, tool: e.tool })
    throw new Error(`$.mcp.call(${e.server}, ${e.tool}) refused: permission denied`)
  })
  on('tool.call', { tool: 'PushNotification' }, ($, e) => {
    seen.pushes.push(String((e as unknown as { message: string }).message))
    return { result: { sent: true } }
  })
  on('tool.call', { tool: 'TaskStop' }, async ($, e) => {
    const taskId = String((e as unknown as { task_id: string }).task_id)
    seen.taskStops.push(taskId)
    if (options.taskStop === 'refused') return { deny: 'auto mode could not evaluate TaskStop' }
    if (options.taskStop === 'slow') await clock.sleep(10000)
    return { result: { message: `Successfully stopped task: ${taskId}` }, text: `Successfully stopped task: ${taskId}` } as never
  })
  return { clock, seen, files, state, store }
}

// The delegate data folder as the mod finds it from the test environment, and
// the files in it that the mod reads: index.json (one row per task) and a
// heartbeat per server instance, { pid, at } with `at` in ms on the mock clock.
export const DELEGATE_DATA = 'C:/Users/me/.claude/consult-delegate'

// One index.json row as delegate-store.js writes it (indexRow).
export function delegateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd3f9a1',
    worker: 'codex',
    model: null,
    title: 'About page',
    project: 'C:/proj',
    state: 'running',
    location: 'copy',
    mode: 'write',
    summary: null,
    fenced: true,
    created_at: 1_000_000,
    queued_at: 1_000_000,
    started_at: 1_000_000,
    ended_at: null,
    stop_reason: null,
    limit: null,
    queue_model: null,
    owner_instance: 'inst-1',
    owner_session: 'session-1',
    reported_at: null,
    queue_waiting_long: false,
    keep_running: false,
    hold: false,
    ...overrides,
  }
}

export function delegateIndexText(rows: Record<string, unknown>[]): string {
  return JSON.stringify({ updated_at: 1_000_000, tasks: rows })
}

export function setDelegateIndex(w: World, rows: Record<string, unknown>[]): void {
  w.files[`${DELEGATE_DATA}/index.json`] = delegateIndexText(rows)
}

export function beatInstance(w: World, instance: string, at: number): void {
  w.files[`${DELEGATE_DATA}/servers/${instance}.json`] = JSON.stringify({ pid: 4242, at })
}

// Stands in for the delegate tools that start or reopen a task: each answers
// the JSON body `body(tool)` gives, as the server's result text.
export function answerDelegate(on: On, body: (tool: string) => Record<string, unknown>) {
  on('tool.call', { tool: /^mcp__plugin_consult_consult__delegate(_send|_wait)?$/ }, ($, e) => {
    const text = JSON.stringify(body(e.tool.slice(CONSULT.length)), null, 2)
    return { result: [{ type: 'text', text }], text } as never
  })
}

// Stands in for consult's MCP server: every consult tool answers `fixture`
// after `afterMs` on the mock clock.
export function answerConsult(on: On, clock: MockClock, fixture: RanResult | ((tool: string) => RanResult), options: { afterMs?: number } = {}) {
  on('tool.call', { tool: /^mcp__plugin_consult_consult__/ }, async ($, e) => {
    if (options.afterMs) await clock.sleep(options.afterMs)
    const answer = typeof fixture === 'function' ? fixture(e.tool) : fixture
    return answer as never
  })
}

