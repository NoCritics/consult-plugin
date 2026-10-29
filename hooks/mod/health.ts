import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Health, ServiceHealth, ServiceName } from '../../types'
import { loadConsultSettings, localConfigured } from './settings'
import { INITIAL_HEALTH } from './state'

// consult's health in the status line: once at the start of a session (until
// the first prompt), then only while a service is broken.

const healthAtom = atom({ plugin: 'consult', key: 'health' } as const, INITIAL_HEALTH)
const finishedAtom = atom({ plugin: 'consult', key: 'finished' } as const, [] as string[])
const turnAtom = atom({ plugin: 'consult', key: 'turn' } as const, null as number | null)

const CHECK_DELAY_MS = 2000
const CHECK_LIMIT_MS = 15000
const SERVICES: ServiceName[] = ['codex', 'agy', 'local']
const MARKS: Record<ServiceHealth['state'], string> = {
  checking: '…',
  ok: '✓',
  broken: '✗',
  absent: '–',
  unknown: '?',
}

export function serviceMark(health: ServiceHealth): string {
  return MARKS[health.state]
}

export function statusLine(h: Health): string | undefined {
  if (h.showStartLine) {
    for (const service of SERVICES) {
      if (h.services[service].state === 'checking') return 'checking…'
    }
    const parts: string[] = []
    for (const service of SERVICES) parts.push(`${service} ${serviceMark(h.services[service])}`)
    return parts.join(' ')
  }
  for (const service of SERVICES) {
    const one = h.services[service]
    if (one.state === 'broken') return `${service} ✗ ${one.reason ?? 'not working'}`
  }
  return undefined
}

async function setService($: EngineInterface, service: ServiceName, next: ServiceHealth): Promise<void> {
  await update($, healthAtom, h => ({ ...h, services: { ...h.services, [service]: next } }))
  $.ui.status(statusLine(await read($, healthAtom)))
}

export async function markBroken($: EngineInterface, service: ServiceName, reason: string): Promise<void> {
  await setService($, service, { state: 'broken', reason })
}

export async function markHealthy($: EngineInterface, service: ServiceName): Promise<void> {
  const current = (await read($, healthAtom)).services[service]
  if (current.state === 'ok') return
  await setService($, service, { state: 'ok', reason: null })
}

// One status check's answer as a service's health. A CLI that is not
// installed is drawn as absent, not broken: it is not part of this setup.
export function healthFromStatus(service: ServiceName, body: Record<string, unknown> | null): ServiceHealth {
  if (body === null) return { state: 'unknown', reason: null }
  if (service === 'codex') {
    if (body.authenticated === true) return { state: 'ok', reason: null }
    if (body.exit_code === 127) return { state: 'absent', reason: null }
    // No exit code: the status check itself timed out or failed.
    if (typeof body.exit_code !== 'number') return { state: 'unknown', reason: null }
    return { state: 'broken', reason: 'not signed in — run codex login' }
  }
  if (service === 'agy') {
    if (body.authenticated === true) return { state: 'ok', reason: null }
    if (body.reason === 'binary_missing') return { state: 'absent', reason: null }
    if (body.reason === 'ineligible_tier') return { state: 'broken', reason: 'account not eligible' }
    if (/sign.?in|auth|log.?in|credential/i.test(String(body.details ?? ''))) {
      return { state: 'broken', reason: 'not signed in — run agy once' }
    }
    return { state: 'unknown', reason: null }
  }
  // A llama-swap answers without its key, but every call would fail.
  if (body.reason === 'needs_key') return { state: 'broken', reason: 'needs its key — run /consult:setlocal' }
  if (body.reason === 'key_rejected') return { state: 'broken', reason: 'key rejected' }
  if (body.reason === 'key_missing') return { state: 'broken', reason: 'key variable not set' }
  if (body.reachable === true) return { state: 'ok', reason: null }
  return { state: 'broken', reason: 'runner not reachable' }
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

// The status bodies hooks/scripts/health.js prints, or null when it did not
// run, exited with an error, printed no JSON object or outlived the limit.
async function runHealthScript($: EngineInterface, services: ServiceName[]): Promise<Record<string, unknown> | null> {
  let timer: { cancel: () => void } | null = null
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = $.clock.after(CHECK_LIMIT_MS, () => resolve('timeout'))
  })
  try {
    // Not $.mcp.call: it goes through the permission check, which auto mode
    // refuses at session start and default mode would ask the person about.
    // Started in the plugin's folder with the project as an argument: in the
    // project's folder, a node.exe planted there could be what runs.
    const ran = $.process.run(['node', `${$.plugin.root}/hooks/scripts/health.js`, await $.session.cwd(), ...services], {
      cwd: $.plugin.root,
      timeoutMs: CHECK_LIMIT_MS,
    })
    const answer = await Promise.race([ran, timedOut])
    if (answer === 'timeout' || answer.exitCode !== 0) return null
    return objectOrNull(JSON.parse(answer.stdout))
  } catch {
    return null
  } finally {
    ;(timer as { cancel: () => void } | null)?.cancel()
  }
}

async function runChecks($: EngineInterface, services: ServiceName[]): Promise<void> {
  const bodies = await runHealthScript($, services)
  for (const service of services) {
    const body = bodies === null ? null : objectOrNull(bodies[service])
    await setService($, service, healthFromStatus(service, body))
  }
}

// Called from register.tsx's session.start hook in an interactive session.
export async function startHealth($: EngineInterface): Promise<void> {
  const settings = await loadConsultSettings($)
  const hasLocal = localConfigured(settings)
  const checking: ServiceHealth = { state: 'checking', reason: null }
  const start: Health = {
    services: { codex: checking, agy: checking, local: hasLocal ? checking : { state: 'absent', reason: null } },
    showStartLine: true,
  }
  await update($, healthAtom, () => start)
  $.ui.status(statusLine(start))
  const services: ServiceName[] = hasLocal ? ['codex', 'agy', 'local'] : ['codex', 'agy']
  // The checks start after start-up, so they never hold it up.
  $.clock.after(CHECK_DELAY_MS, () => {
    void runChecks($, services).catch(() => undefined)
  })
}

// Called from register.tsx's prompt.submit hook for every prompt: the turn
// the next calls keep, and on the person's own prompt the start line and the
// finished row clear.
export async function notePrompt($: EngineInterface, isMeta: boolean, originKind: string): Promise<void> {
  // A prompt starts a new turn: the pane boxes its calls together. A task
  // notification (a backgrounded call finishing) and meta prompts do not.
  if (!isMeta && originKind !== 'task-notification') {
    const sentAt = await $.clock.now()
    await update($, turnAtom, () => sentAt)
  }
  // Only the person's own prompt: not a task notification, a scheduled
  // trigger or a plugin's prompt.
  const isPerson = !isMeta && (originKind === 'composer' || originKind === 'bridge')
  if (isPerson) {
    await update($, healthAtom, h => ({ ...h, showStartLine: false }))
    await update($, finishedAtom, () => [])
    $.ui.status(statusLine(await read($, healthAtom)))
  }
}
