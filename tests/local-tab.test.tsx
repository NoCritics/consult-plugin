import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { LocalSetupView, LocalShow } from '../types'
import { PLUGIN, world } from './world'
import { noteText, previewArgs } from '../hooks/mod/local-setup'
import { INITIAL_LOCAL } from '../hooks/mod/state'

const PANE = {
  plugin: PLUGIN,
  surface: 'terminal',
  component: 'Pane',
  requestId: 'consult',
  props: { title: 'consult', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const COMMAND = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true } }

const SWAP_PROBE = { url: 'http://127.0.0.1:9292/v1', type: 'llama-swap', up: true, needs_key: false, key_env: 'LLAMA_SWAP_API_KEY', models: ['qwen3.5-4b', 'qwen3.6-35b-a3b', 'flash-next'], configured: 'llama-swap' }
const OLLAMA_PROBE = { url: 'http://127.0.0.1:11434/v1', type: 'ollama', up: true, needs_key: false, key_env: null, models: ['qwen3.5:4b'], configured: null }

const MODELS = [
  { id: 'flash-next', name: 'Flash-Next', description: 'Ceiling rung', vision: null, loaded: false },
  { id: 'qwen3.5-4b', name: 'Qwen3.5 4B (vision)', description: 'Fastest rung', vision: true, loaded: false },
  { id: 'qwen3.6-35b-a3b', name: 'Qwen3.6 35B-A3B', description: 'Default local model', vision: null, loaded: false },
]

function row(role: string, proposed: string[], saved: string | null) {
  return { role, proposed, saved, saved_state: saved === null ? 'none' : 'kept', replacement: null, reason: `reason for ${role}` }
}

// llama-swap in use, every nickname saved.
const SHOWN: LocalShow = {
  probe: [SWAP_PROBE, OLLAMA_PROBE],
  configured: [{ type: 'llama-swap', url: 'http://127.0.0.1:9292/v1', in_use: true }],
  in_use: 'llama-swap',
  settings_warnings: [],
  runner: 'llama-swap',
  url: 'http://127.0.0.1:9292/v1',
  reachable: true,
  proposal: {
    rows: [
      row('default', ['qwen3.6-35b-a3b'], 'qwen3.6-35b-a3b'),
      row('fast', ['qwen3.5-4b'], 'qwen3.5-4b'),
      row('vision', ['qwen3.5-4b'], 'qwen3.5-4b'),
      row('vision_best', ['qwen3.5-4b'], 'qwen3.5-4b'),
      row('big', ['flash-next'], 'flash-next'),
    ],
    new_models: [],
    models: MODELS,
  },
  other_loaded: [],
} as unknown as LocalShow

// A first setup: nothing saved, and two models tied for big.
const TIED: LocalShow = {
  ...SHOWN,
  in_use: null,
  configured: [],
  proposal: {
    ...SHOWN.proposal!,
    rows: [
      row('default', ['qwen3.6-35b-a3b'], null),
      row('fast', ['qwen3.5-4b'], null),
      row('vision', ['qwen3.5-4b'], null),
      row('vision_best', ['qwen3.5-4b'], null),
      row('big', ['flash-next', 'qwen3.6-35b-a3b'], null),
    ],
  },
} as unknown as LocalShow

const DIFF = { preview: { path: 'C:/Users/me/.claude/consult.local.md', diff: ['- 14: llama-swap.vision_best: qwen3.5-4b', '+ 14: llama-swap.vision_best: flash-next'] } }

function slashes(path: string): string {
  return path.replace(/\\/g, '/')
}

function commandsRun(w: ReturnType<typeof world>): string[] {
  const commands: string[] = []
  for (const run of w.seen.setlocalRuns) commands.push(run.argv[3] ?? '')
  return commands
}

async function openLocal($: Engine) {
  await $.command.run({ command: 'consult', ...COMMAND } as never)
}

describe('local models tab', () => {
  test('opening the tab runs setlocal.js show with the project as an argument, from the plugin folder', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: () => SHOWN })
    await openLocal($)
    await w.clock.settle()
    const run = w.seen.setlocalRuns[0]
    expect(run?.argv.slice(2)).toEqual(['C:/proj', 'show'])
    expect(slashes(run?.cwd ?? '')).toBe(slashes(run?.argv[1] ?? '').replace(/\/hooks\/scripts\/setlocal\.js$/, ''))
  })

  test('the five nickname pickers start on the saved models', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: () => SHOWN })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    for (const [role, model] of [['default', 'qwen3.6-35b-a3b'], ['fast', 'qwen3.5-4b'], ['vision', 'qwen3.5-4b'], ['vision_best', 'qwen3.5-4b'], ['big', 'flash-next']]) {
      expect((await ui.find({ key: `local:role:${role}` }))?.props.value, role).toBe(model)
    }
    expect((await ui.find({ key: 'local:runner' }))?.props.value).toBe('llama-swap')
    await ui.unmount()
  })

  test('a tie starts on its first tied model, both marked (tie), and Save works', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: args => (args[0] === 'show' ? TIED : DIFF) })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    const big = await ui.find({ key: 'local:role:big' })
    expect(big?.props.value).toBe('flash-next')
    const labels: string[] = []
    for (const option of (big?.props.options ?? []) as Array<{ label: string }>) labels.push(option.label)
    expect(labels.some(label => /pick one/.test(label))).toBe(false)
    expect(labels).toContain('○ flash-next (tie)')
    expect(labels).toContain('  qwen3.6-35b-a3b (tie)')
    expect(await ui.find({ text: /pick one/ })).toBeUndefined()
    await w.clock.advance(1000)
    await ui.press({ key: 'local:save' })
    await w.clock.settle()
    expect(commandsRun(w).includes('save')).toBe(true)
    await ui.unmount()
  })

  test('two quick picks make one preview, of the second pick', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: args => (args[0] === 'show' ? SHOWN : DIFF) })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.select({ key: 'local:role:vision_best', value: 'qwen3.6-35b-a3b' })
    await w.clock.advance(100)
    await ui.select({ key: 'local:role:vision_best', value: 'flash-next' })
    await w.clock.advance(1000)
    const previews = w.seen.setlocalRuns.filter(run => run.argv[3] === 'preview')
    expect(previews.length).toBe(1)
    expect(JSON.parse(previews[0]?.argv[4] ?? '{}')).toEqual({ runner: 'llama-swap', save: { vision_best: 'flash-next' } })
    expect(await ui.find({ text: /\+ 14: llama-swap\.vision_best: flash-next/ })).toBeDefined()
    await ui.unmount()
  })

  test('an older preview that answers late does not replace a newer one', async ($, on) => {
    let releaseFirst: (value: unknown) => void = () => {}
    let previewCount = 0
    const w = world(on, {
      store: { 'pane-tab': 'local' },
      setlocal: args => {
        if (args[0] === 'show') return SHOWN
        previewCount++
        if (previewCount === 1) return new Promise(resolve => { releaseFirst = resolve })
        return { preview: { path: 'x', diff: ['+ 14: llama-swap.vision_best: flash-next'] } }
      },
    })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.select({ key: 'local:role:vision_best', value: 'qwen3.6-35b-a3b' })
    await w.clock.advance(1000)
    await ui.select({ key: 'local:role:vision_best', value: 'flash-next' })
    await w.clock.advance(1000)
    releaseFirst({ preview: { path: 'x', diff: ['+ 14: llama-swap.vision_best: qwen3.6-35b-a3b'] } })
    await w.clock.settle()
    expect(await ui.find({ text: /vision_best: flash-next/ })).toBeDefined()
    expect(await ui.find({ text: /vision_best: qwen3\.6-35b-a3b/ })).toBeUndefined()
    await ui.unmount()
  })

  test('text typed in a field stays through a redraw', async ($, on) => {
    const needsKey = { ...SHOWN, probe: [{ ...SWAP_PROBE, needs_key: true, key_env: null }], proposal: null, reachable: false, in_use: null, configured: [] }
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: args => (args[0] === 'show' ? needsKey : DIFF) })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.input({ key: 'local:key_env', text: 'MY_SWAP_K', kind: 'change' })
    await ui.press({ key: 'tab:answers' })
    await ui.press({ key: 'tab:local' })
    await w.clock.settle()
    expect((await ui.find({ key: 'local:key_env' }))?.props.value).toBe('MY_SWAP_K')
    await ui.unmount()
  })

  test('Save writes once, tells Claude with a note row and the person with a toast, then reads again', async ($, on) => {
    const saved = { ...SHOWN, saved: { path: 'C:/Users/me/.claude/consult.local.md', diff: DIFF.preview.diff, written: { 'llama-swap.vision_best': 'flash-next' } } }
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: args => (args[0] === 'save' ? saved : args[0] === 'show' ? SHOWN : DIFF) })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.select({ key: 'local:role:vision_best', value: 'flash-next' })
    await w.clock.advance(1000)
    await ui.press({ key: 'local:save' })
    await w.clock.settle()
    expect(commandsRun(w)).toEqual(['show', 'preview', 'save', 'show'])
    expect(w.seen.appended).toEqual(['consult: local runner still llama-swap; vision-best flash-next'])
    expect(w.seen.toasts.at(-1)).toBe('consult: local runner still llama-swap; vision-best flash-next')
    await ui.unmount()
  })

  test('Save and unload unloads the runner holding a model after saving', async ($, on) => {
    const holding = { ...SHOWN, other_loaded: [{ type: 'ollama', url: 'http://127.0.0.1:11434/v1', loaded: ['qwen3.5:4b'] }] }
    const saved = { ...holding, saved: { path: 'p', diff: [], written: { 'llama-swap.vision_best': 'flash-next' } } }
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: args => (args[0] === 'save' ? saved : args[0] === 'unload' ? { runner: 'ollama', unloaded: ['qwen3.5:4b'] } : args[0] === 'show' ? holding : DIFF) })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.select({ key: 'local:role:vision_best', value: 'flash-next' })
    await w.clock.advance(1000)
    expect(String((await ui.find({ key: 'local:save-unload' }))?.props.label)).toContain('qwen3.5:4b')
    await ui.press({ key: 'local:save-unload' })
    await w.clock.settle()
    const unload = w.seen.setlocalRuns.find(run => run.argv[3] === 'unload')
    expect(unload?.argv.slice(3)).toEqual(['unload', 'ollama'])
    expect(commandsRun(w).indexOf('save')).toBeLessThan(commandsRun(w).indexOf('unload'))
    await ui.unmount()
  })

  test('a script that cannot start, never answers, or refuses shows its error', async ($, on) => {
    let answer: unknown = 'throw'
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: () => answer })
    await openLocal($)
    await w.clock.settle()
    let ui = await $.ui.mount(PANE)
    expect(await ui.find({ text: /setup script/ })).toBeDefined()
    await ui.unmount()

    answer = 'hang'
    ui = await $.ui.mount(PANE)
    // The press waits for the script: the clock runs meanwhile.
    const pressing = ui.press({ key: 'local:refresh' })
    await w.clock.settle()
    await w.clock.advance(20000)
    await pressing
    expect(await ui.find({ text: /didn't answer/ })).toBeDefined()
    await ui.unmount()

    answer = { error: 'Nothing was saved: `x` is not listed by llama-swap.' }
    ui = await $.ui.mount(PANE)
    await ui.press({ key: 'local:refresh' })
    await w.clock.settle()
    expect(await ui.find({ text: /is not listed by llama-swap/ })).toBeDefined()
    await ui.unmount()
  })

  test('a warning printed before the JSON does not break reading it', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: () => ({ stdout: `(node:1) Warning: something\n${JSON.stringify(SHOWN)}\n`, exitCode: 0 }) })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ key: 'local:role:fast' }))?.props.value).toBe('qwen3.5-4b')
    await ui.unmount()
  })

  test('a surface that draws no pickers gets one line instead of the form', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: () => SHOWN })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    expect(await ui.find({ text: /can't draw the setup form/ })).toBeDefined()
    expect(await ui.find({ key: 'local:role:fast' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('local models tab: the change and the note', () => {
  const ready: LocalSetupView = {
    ...INITIAL_LOCAL,
    status: 'ready',
    shown: SHOWN,
    runner: 'llama-swap',
    picks: { default: 'qwen3.6-35b-a3b', fast: 'qwen3.5-4b', vision: 'qwen3.5-4b', vision_best: 'qwen3.5-4b', big: 'flash-next' },
  }

  test('previewArgs: nothing differs, nothing to preview', () => {
    expect(previewArgs(ready)).toBe(null)
  })

  test('previewArgs: only the changed roles; none removes a saved one', () => {
    const view = { ...ready, picks: { ...ready.picks, fast: 'flash-next', vision: '__none__' } }
    expect(previewArgs(view)).toEqual({ runner: 'llama-swap', save: { fast: 'flash-next', vision: null } })
  })

  test('previewArgs: another runner is made the one in use, with the fields typed', () => {
    const view = { ...ready, runner: 'ollama', use: true, fields: { url: '', key_env: '', start: 'ollama app' }, picks: { ...ready.picks } }
    const args = previewArgs({ ...view, shown: { ...SHOWN, runner: 'ollama', in_use: 'llama-swap' } })
    expect(args).toEqual({ runner: 'ollama', use: true, start: 'ollama app' })
  })

  test('noteText: now, still, and a removed nickname', () => {
    expect(noteText('llama-swap', { local_runner: 'llama-swap', 'llama-swap.default': 'qwen3.6-35b-a3b', 'llama-swap.fast': 'qwen3.5-4b' }, 'ollama')).toBe(
      'consult: local runner now llama-swap; default qwen3.6-35b-a3b, fast qwen3.5-4b',
    )
    expect(noteText('llama-swap', { 'llama-swap.vision_best': 'flash-next' }, 'llama-swap')).toBe('consult: local runner still llama-swap; vision-best flash-next')
    expect(noteText('llama-swap', { 'llama-swap.big': null }, 'llama-swap')).toBe('consult: local runner still llama-swap; big none')
  })
})

describe('/consult:setlocal', () => {
  test('typed at the prompt, it opens the pane on Local models instead of running the chat steps', async ($, on) => {
    const w = world(on, { setlocal: () => SHOWN })
    const ran = await $.command.run({ command: 'consult:setlocal', ...COMMAND } as never)
    await w.clock.settle()
    expect(ran.text).toBeUndefined()
    expect(w.seen.opened).toEqual(['consult'])
    expect((w.state.pane as { tab: string }).tab).toBe('local')
    expect(w.seen.setlocalRuns[0]?.argv.slice(3)).toEqual(['show'])
  })

  test('a runner argument is the runner shown; anything else is ignored', async ($, on) => {
    const w = world(on, { setlocal: () => SHOWN })
    await $.command.run({ command: 'consult:setlocal', ...COMMAND, args: 'ollama' } as never)
    await w.clock.settle()
    expect(w.seen.setlocalRuns.at(-1)?.argv.slice(3)).toEqual(['show', 'ollama'])
    await $.command.run({ command: 'consult:setlocal', ...COMMAND, args: 'not-a-runner' } as never)
    await w.clock.settle()
    expect(w.seen.setlocalRuns.at(-1)?.argv.slice(3)).toEqual(['show'])
  })

  test('from anywhere but the prompt, the chat steps run', async ($, on) => {
    const w = world(on, { setlocal: () => SHOWN })
    const ran = await $.command.run({ command: 'consult:setlocal', ...COMMAND, origin: { kind: 'sdk' } } as never)
    expect(ran.text).toBe('(no such command)')
    expect(w.seen.opened).toEqual([])
  })

  test('when the pane cannot open, the chat steps run', async ($, on) => {
    const w = world(on, { setlocal: () => SHOWN, openThrows: true })
    const ran = await $.command.run({ command: 'consult:setlocal', ...COMMAND } as never)
    expect(ran.text).toBe('(no such command)')
    expect(w.seen.opened).toEqual([])
  })
})

describe('local models tab: review fixes', () => {
  test('review 1: a pick right after a diff hides that diff, and Save waits for the new one', async ($, on) => {
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: args => (args[0] === 'show' ? SHOWN : DIFF) })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.select({ key: 'local:role:vision_best', value: 'flash-next' })
    await w.clock.advance(1000)
    await ui.select({ key: 'local:role:vision_best', value: 'qwen3.6-35b-a3b' })
    await ui.press({ key: 'local:save' })
    await w.clock.settle()
    expect(commandsRun(w).includes('save')).toBe(false)
    expect(await ui.find({ text: /vision_best: flash-next/ })).toBeUndefined()
    await ui.unmount()
  })

  test('review 2: a second Save while the first runs does nothing; later saves keep the first .bak', async ($, on) => {
    let releaseSave: (value: unknown) => void = () => {}
    const saved = { ...SHOWN, saved: { path: 'p', diff: [], written: { 'llama-swap.vision_best': 'flash-next' } } }
    const w = world(on, {
      store: { 'pane-tab': 'local' },
      setlocal: args => {
        if (args[0] === 'save') return new Promise(resolve => { releaseSave = resolve })
        return args[0] === 'show' ? SHOWN : DIFF
      },
    })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.select({ key: 'local:role:vision_best', value: 'flash-next' })
    await w.clock.advance(1000)
    const first = ui.press({ key: 'local:save' })
    await w.clock.settle()
    await ui.press({ key: 'local:save' })
    releaseSave(saved)
    await first
    await w.clock.settle()
    const saves: { argv: string[] }[] = []
    for (const run of w.seen.setlocalRuns) {
      if (run.argv[3] === 'save') saves.push(run)
    }
    expect(saves.length).toBe(1)
    expect(JSON.parse(saves[0]?.argv[4] ?? '{}').keep_backup).toBeUndefined()
    await ui.select({ key: 'local:role:big', value: 'qwen3.5-4b' })
    await w.clock.advance(1000)
    const second = ui.press({ key: 'local:save' })
    await w.clock.settle()
    releaseSave(saved)
    await second
    const later: { argv: string[] }[] = []
    for (const run of w.seen.setlocalRuns) {
      if (run.argv[3] === 'save') later.push(run)
    }
    expect(JSON.parse(later[1]?.argv[4] ?? '{}').keep_backup).toBe(true)
    await ui.unmount()
  })

  test("review 3: saving another runner's nicknames names the runner still in use", () => {
    expect(noteText('ollama', { 'ollama.fast': 'qwen3.5:4b' }, 'llama-swap')).toBe('consult: local runner still llama-swap; ollama fast qwen3.5:4b')
    expect(noteText('ollama', { 'ollama.fast': 'qwen3.5:4b' }, null)).toBe('consult: no local runner in use; ollama fast qwen3.5:4b')
  })

  test('review 4: the address field stays while an address is typed', async ($, on) => {
    const notFound = { ...SHOWN, runner: 'llama-server', url: undefined, reachable: undefined, proposal: null, note: "llama-server wasn't found on this machine" }
    const found = { ...SHOWN, runner: 'llama-server', url: 'http://127.0.0.1', proposal: null, preview: { path: 'p', diff: ['+ 3: llama-server.url: http://127.0.0.1'] } }
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: args => (args[0] === 'show' ? notFound : found) })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.input({ key: 'local:url', text: 'http://127.0.0.1', kind: 'change' })
    await w.clock.advance(1000)
    expect((await ui.find({ key: 'local:url' }))?.props.value).toBe('http://127.0.0.1')
    await ui.unmount()
  })

  test('review 5: a runner with no proposal rows still gets a picker per nickname from its models', async ($, on) => {
    const plain = { ...SHOWN, runner: 'openai', in_use: 'openai', proposal: { rows: [], models: ['m-one', 'm-two'] } }
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: () => plain })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    const picker = await ui.find({ key: 'local:role:default' })
    expect(picker?.props.value).toBe('__none__')
    const values: string[] = []
    for (const option of (picker?.props.options ?? []) as { value: string }[]) values.push(option.value)
    expect(values).toEqual(['m-one', 'm-two', '__none__'])
    await ui.unmount()
  })

  test('review 6: picking another runner right after a pick previews nothing for the old one', async ($, on) => {
    const ollamaShown = { ...SHOWN, runner: 'ollama', in_use: 'llama-swap', proposal: { rows: [], models: ['qwen3.5:4b'] } }
    let releaseOllama: (value: unknown) => void = () => {}
    const w = world(on, {
      store: { 'pane-tab': 'local' },
      setlocal: args => {
        if (args[0] === 'show' && args[1] === 'ollama') return new Promise(resolve => { releaseOllama = resolve })
        // llama-swap set up but not in use: its preview would make it the one in use.
        return args[0] === 'show' ? TIED : DIFF
      },
    })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    await ui.select({ key: 'local:role:vision_best', value: 'flash-next' })
    // Ollama is still being read when the pick's pause runs out.
    const runsBefore = w.seen.setlocalRuns.length
    const picking = ui.select({ key: 'local:runner', value: 'ollama' })
    await w.clock.settle()
    await w.clock.advance(1000)
    releaseOllama(ollamaShown)
    await picking
    await w.clock.advance(1000)
    for (const run of w.seen.setlocalRuns.slice(runsBefore)) {
      if (run.argv[3] === 'preview') expect(JSON.parse(run.argv[4] ?? '{}').runner).toBe('ollama')
    }
    expect((await ui.find({ key: 'local:runner' }))?.props.value).toBe('ollama')
    await ui.unmount()
  })

  test('review 7: a key typed where its variable name belongs is never sent', () => {
    const view: LocalSetupView = {
      ...INITIAL_LOCAL,
      status: 'ready',
      shown: SHOWN,
      runner: 'llama-swap',
      picks: { default: 'qwen3.6-35b-a3b', fast: 'qwen3.5-4b', vision: 'qwen3.5-4b', vision_best: 'qwen3.5-4b', big: 'flash-next' },
      fields: { url: '', key_env: 'sk-abc.def', start: '' },
    }
    expect(previewArgs(view)).toBe(null)
    expect(previewArgs({ ...view, fields: { url: '', key_env: 'MY_KEY', start: '' } })).toEqual({ runner: 'llama-swap', key_env: 'MY_KEY' })
  })

  test('review 8: a Refresh that fails shows the error, not the old form', async ($, on) => {
    let answer: unknown = SHOWN
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: () => answer })
    await openLocal($)
    await w.clock.settle()
    const ui = await $.ui.mount(PANE)
    answer = { error: 'llama-swap stopped answering' }
    await ui.press({ key: 'local:refresh' })
    await w.clock.settle()
    expect(await ui.find({ text: /stopped answering/ })).toBeDefined()
    expect(await ui.find({ key: 'local:role:fast' })).toBeUndefined()
    expect(await ui.find({ text: /In use: llama-swap/ })).toBeUndefined()
    await ui.unmount()
  })

  test('review 9: when the pane is not placed anywhere, the chat steps run', async ($, on) => {
    world(on, { setlocal: () => SHOWN, openNotPlaced: true })
    const ran = await $.command.run({ command: 'consult:setlocal', ...COMMAND } as never)
    expect(ran.text).toBe('(no such command)')
  })
})

// The layout from the live run-through: one line per nickname, the models
// listed once, colour only where it carries meaning.
describe('local models tab: layout', () => {
  // vision-best on a model nobody knows reads images; one model no nickname uses.
  const LAYOUT: LocalShow = {
    ...SHOWN,
    proposal: {
      ...SHOWN.proposal!,
      rows: [
        row('default', ['qwen3.6-35b-a3b'], 'qwen3.6-35b-a3b'),
        row('fast', ['qwen3.5-4b'], 'qwen3.5-4b'),
        row('vision', ['qwen3.5-4b'], 'qwen3.5-4b'),
        row('vision_best', ['flash-next'], 'flash-next'),
        row('big', ['flash-next'], 'flash-next'),
      ],
      new_models: ['qwen3.8-27b'],
      models: [
        { id: 'flash-next', name: 'Flash-Next', description: 'Ceiling rung', vision: null, loaded: false, arch: 'MoE', engine: 'Strata', decode_tps: 7 },
        { id: 'qwen3.5-4b', name: 'Qwen3.5 4B (vision)', description: 'Fastest rung', vision: true, loaded: false, arch: 'dense', engine: 'llama.cpp', decode_tps: 71 },
        { id: 'qwen3.6-35b-a3b', name: 'Qwen3.6 35B-A3B', description: 'Default local model', vision: null, loaded: false, arch: 'MoE', engine: 'llama.cpp', decode_tps: 38 },
        { id: 'qwen3.8-27b', name: 'Qwen3.8 27B', description: 'Dense quality rung', vision: null, loaded: false, arch: 'dense', engine: 'llama.cpp', decode_tps: '5-6' },
        { id: 'plain', name: 'Plain', description: 'no facts written for it', vision: null, loaded: false },
      ],
    },
  } as unknown as LocalShow

  async function mountWith($: Engine, on: Parameters<typeof world>[0], shown: unknown, extra: Partial<Parameters<typeof world>[1]> = {}) {
    const w = world(on, { store: { 'pane-tab': 'local' }, setlocal: args => (args[0] === 'show' ? shown : DIFF), ...extra })
    await openLocal($)
    await w.clock.settle()
    return { w, ui: await $.ui.mount(PANE) }
  }

  test('a nickname picker lists model names only, with no marks after them', async ($, on) => {
    const { ui } = await mountWith($, on, LAYOUT)
    const options = (await ui.find({ key: 'local:role:default' }))?.props.options as { label: string }[]
    for (const option of options) expect(option.label).not.toMatch(/[✓✗?]/)
    await ui.unmount()
  })

  test('vision and vision-best warn "⚠ images" only when their model is not known to read images', async ($, on) => {
    const { ui } = await mountWith($, on, LAYOUT)
    const warnings = await ui.findAll({ type: 'Text', text: /⚠ images/ })
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.props.color).toBe('warning')
    await ui.unmount()
  })

  test('no per-row "saved" line or description under a nickname', async ($, on) => {
    const { ui } = await mountWith($, on, LAYOUT)
    expect(await ui.find({ text: /^\s*saved\s*$/ })).toBeUndefined()
    expect(await ui.find({ text: /Qwen3\.5 4B \(vision\): Fastest rung/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the models list their facts only: type, engine, speed, images; columns aligned, unused ones dim', async ($, on) => {
    const { ui } = await mountWith($, on, LAYOUT)
    expect(await ui.find({ text: /^MODELS/ })).toBeDefined()
    const lines: { text: string; dim: unknown }[] = []
    for (const id of ['flash-next', 'qwen3.5-4b', 'qwen3.6-35b-a3b', 'qwen3.8-27b']) {
      const found = await ui.find({ type: 'Text', text: new RegExp(`^${id.replace(/\./g, '\\.')}\\s`) })
      expect(found, id).toBeDefined()
      lines.push({ text: String(found?.text), dim: found?.props.dimColor })
    }
    expect(lines[0]?.text).toMatch(/^flash-next\s+MoE\s+Strata\s+7 t\/s$/)
    expect(lines[1]?.text).toMatch(/^qwen3\.5-4b\s+dense\s+llama\.cpp\s+71 t\/s\s+images$/)
    expect(lines[3]?.text).toMatch(/^qwen3\.8-27b\s+dense\s+llama\.cpp\s+5-6 t\/s$/)
    // Each column starts at one place, and the speeds end at one place.
    const engineAt = new Set<number>()
    const speedEnd = new Set<number>()
    for (const line of lines) {
      engineAt.add(line.text.search(/(Strata|llama\.cpp)/))
      speedEnd.add(line.text.indexOf('t/s') + 3)
    }
    expect(engineAt.size).toBe(1)
    expect(speedEnd.size).toBe(1)
    for (const line of lines) expect(line.text).not.toMatch(/rung|Default local/)
    expect(lines[3]?.dim).toBe(true)
    expect(lines[0]?.dim).not.toBe(true)
    await ui.unmount()
  })

  test('a model with no facts written shows its description instead', async ($, on) => {
    const { ui } = await mountWith($, on, LAYOUT)
    expect(String((await ui.find({ type: 'Text', text: /^plain\s/ }))?.text)).toMatch(/^plain\s+no facts written for it$/)
    await ui.unmount()
  })

  test('a speed measured on your calls shows as ~N t/s, said so once', async ($, on) => {
    const measured = {
      ...LAYOUT,
      proposal: {
        ...LAYOUT.proposal!,
        models: [
          ...(LAYOUT.proposal!.models as object[]),
          { id: 'seen-model', name: 'Seen', description: '', vision: null, loaded: false, arch: 'dense', engine: 'llama.cpp', decode_tps: null, measured_tps: 44 },
        ],
      },
    }
    const { ui } = await mountWith($, on, measured)
    expect(String((await ui.find({ type: 'Text', text: /^seen-model\s/ }))?.text)).toMatch(/^seen-model\s+dense\s+llama\.cpp\s+~44 t\/s$/)
    expect(await ui.find({ type: 'Text', text: /~ measured on your calls/ })).toBeDefined()
    await ui.unmount()
  })

  test('a model picked for big is no longer dim', async ($, on) => {
    const { w, ui } = await mountWith($, on, LAYOUT)
    await ui.select({ key: 'local:role:big', value: 'qwen3.8-27b' })
    await w.clock.advance(1000)
    expect((await ui.find({ type: 'Text', text: /^qwen3\.8-27b\s/ }))?.props.dimColor).not.toBe(true)
    await ui.unmount()
  })

  test('the picker list marks the saved model ● and a picked one not saved yet ○', async ($, on) => {
    const { w, ui } = await mountWith($, on, LAYOUT)
    const labels = async () => {
      const byValue: Record<string, string> = {}
      for (const option of (await ui.find({ key: 'local:role:default' }))?.props.options as { value: string; label: string }[]) byValue[option.value] = option.label
      return byValue
    }
    let shown = await labels()
    expect(shown['qwen3.6-35b-a3b']).toBe('● qwen3.6-35b-a3b')
    expect(shown['qwen3.5-4b']).toBe('  qwen3.5-4b')
    await ui.select({ key: 'local:role:default', value: 'qwen3.5-4b' })
    await w.clock.advance(1000)
    shown = await labels()
    expect(shown['qwen3.6-35b-a3b']).toBe('● qwen3.6-35b-a3b')
    expect(shown['qwen3.5-4b']).toBe('○ qwen3.5-4b')
    expect(shown['flash-next']).toBe('  flash-next')
    await ui.unmount()
  })

  test('a nickname changed but not saved shows "• was <saved>"', async ($, on) => {
    const { w, ui } = await mountWith($, on, LAYOUT)
    expect(await ui.find({ type: 'Text', text: /•/ })).toBeUndefined()
    await ui.select({ key: 'local:role:big', value: 'qwen3.8-27b' })
    await w.clock.advance(1000)
    const mark = await ui.find({ type: 'Text', text: /• was flash-next/ })
    expect(mark?.props.color).toBe('suggestion')
    await ui.unmount()
  })

  test('a nickname with nothing saved shows "• new"', async ($, on) => {
    const fresh = await mountWith($, on, TIED)
    expect(await fresh.ui.find({ type: 'Text', text: /• new/ })).toBeDefined()
    await fresh.ui.unmount()
  })

  test('a stopped runner lists its saved nicknames and says how to get the pickers back', async ($, on) => {
    const stopped = {
      ...SHOWN,
      probe: [{ ...SWAP_PROBE, up: false, models: [] }],
      reachable: false,
      proposal: null,
      saved_nicknames: { default: 'qwen3.6-35b-a3b', fast: 'qwen3.5-4b', vision: null, vision_best: null, big: 'flash-next' },
      start: 'Desktop shortcut "llama-swap"',
    }
    const { ui } = await mountWith($, on, stopped)
    expect(await ui.find({ key: 'local:role:default' })).toBeUndefined()
    expect(await ui.find({ text: /^default\s+qwen3\.6-35b-a3b$/ })).toBeDefined()
    expect(await ui.find({ text: /^vision\s+—$/ })).toBeDefined()
    const hint = await ui.find({ type: 'Text', text: /llama-swap isn't running: start it \(Desktop shortcut "llama-swap"\), then Refresh/ })
    expect(hint?.props.color).toBe('warning')
    await ui.unmount()
  })

  test('a runner never set up and not running reads "not found"', async ($, on) => {
    const { ui } = await mountWith($, on, LAYOUT)
    const options = ((await ui.find({ key: 'local:runner' }))?.props.options ?? []) as Array<{ label: string }>
    const labels: string[] = []
    for (const option of options) labels.push(option.label)
    expect(labels).toContain('lmstudio — not found')
    expect(labels.some(label => label.includes('not set up'))).toBe(false)
    await ui.unmount()
  })

  test('the marks beside a picker never wrap: only the dim note gives way', async ($, on) => {
    const { ui } = await mountWith($, on, TIED)
    const markBoxes = await ui.findAll({ type: 'Box', text: /^\s*• new$/ })
    expect(markBoxes.length).toBeGreaterThan(0)
    for (const box of markBoxes) expect(box.props.flexShrink).toBe(0)
    await ui.unmount()
  })

  test('a stopped llama-swap asks for no key', async ($, on) => {
    const stopped = { ...SHOWN, probe: [{ ...SWAP_PROBE, up: false, models: [] }], reachable: false, proposal: null }
    const { ui } = await mountWith($, on, stopped)
    expect(await ui.find({ key: 'local:key_env' })).toBeUndefined()
    await ui.unmount()
  })

  test('the start field is a short "Start note" with its use said under it', async ($, on) => {
    const { ui } = await mountWith($, on, TIED)
    expect((await ui.find({ key: 'local:start' }))?.props.label).toBe('Start note')
    expect(await ui.find({ text: /shown when the runner isn't running/ })).toBeDefined()
    await ui.unmount()
  })

  test('the runner line has a coloured dot for its state and no separate "In use" line', async ($, on) => {
    const { ui } = await mountWith($, on, LAYOUT)
    expect((await ui.find({ type: 'Text', text: /^●/ }))?.props.color).toBe('success')
    expect(await ui.find({ text: /^In use:/ })).toBeUndefined()
    await ui.unmount()
  })

  test('after a save: one green line, the old copy named, no long path', async ($, on) => {
    const saved = { ...LAYOUT, saved: { path: 'C:/Users/me/.claude/consult.local.md', diff: [], written: { 'llama-swap.vision_best': 'qwen3.5-4b' } } }
    const { w, ui } = await mountWith($, on, LAYOUT, { setlocal: args => (args[0] === 'save' ? saved : args[0] === 'show' ? LAYOUT : DIFF) })
    await ui.select({ key: 'local:role:vision_best', value: 'qwen3.5-4b' })
    await w.clock.advance(1000)
    await ui.press({ key: 'local:save' })
    await w.clock.settle()
    const line = await ui.find({ type: 'Text', text: /^✓ Saved · old copy kept as consult\.local\.md\.bak$/ })
    expect(line?.props.color).toBe('success')
    await ui.unmount()
  })
})
