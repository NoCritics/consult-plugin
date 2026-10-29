import type { EngineInterface } from 'claude-code'

export type ScriptAnswer = { json: Record<string, unknown> } | { error: string }

// Runs one of the plugin's scripts (hooks/scripts/<script>) with node, from the plugin's
// folder: a node.exe planted in the project is not what runs. The script is given the project
// (`project` finds it) and `args`, and prints one JSON object as its last line. `label` names the
// script in an error ('delegate' reads "the delegate script didn't answer in 10 s").
export async function runPluginScript(
  $: EngineInterface,
  script: string,
  label: string,
  project: () => Promise<string>,
  args: string[],
  limitMs: number,
): Promise<ScriptAnswer> {
  let timer: { cancel: () => void } | null = null
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = $.clock.after(limitMs, () => resolve('timeout'))
  })
  try {
    const ran = $.process.run(['node', `${$.plugin.root}/hooks/scripts/${script}`, await project(), ...args], {
      cwd: $.plugin.root,
      timeoutMs: limitMs,
    })
    const answer = await Promise.race([ran, timedOut])
    if (answer === 'timeout') return { error: `the ${label} script didn't answer in ${Math.round(limitMs / 1000)} s` }
    if (answer.exitCode !== 0) return { error: `the ${label} script failed (exit ${answer.exitCode})` }
    // The JSON is the last line: a warning node printed first is skipped.
    let last = ''
    for (const line of answer.stdout.split('\n')) {
      if (line.trim() !== '') last = line.trim()
    }
    let json: unknown
    try {
      json = JSON.parse(last)
    } catch {
      return { error: `the ${label} script printed no JSON` }
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return { error: `the ${label} script printed no JSON` }
    const object = json as Record<string, unknown>
    if (typeof object.error === 'string') return { error: object.error }
    return { json: object }
  } catch (error) {
    return { error: `the ${label} script couldn't start (${error instanceof Error ? error.message : String(error)})` }
  } finally {
    ;(timer as { cancel: () => void } | null)?.cancel()
  }
}
