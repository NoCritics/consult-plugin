import type { EngineInterface } from 'claude-code'

import type { LocalModel, LocalRole, LocalRow, LocalSetupView, LocalShow } from '../../types'
import { LOCAL_ROLES, LOCAL_RUNNERS, NO_MODEL, changeLocal, isVariableName, refreshLocal, saveBlocked, saveLocal, savedPicks, submitLocalField } from '../mod/local-setup'

// The Local models tab of the consult pane: the runner, its five nicknames,
// the runner's models, the fields a runner needs, the diff, and Save. Drawn
// from LocalSetupView; every action goes through hooks/mod/local-setup.ts.

type Table = ReturnType<EngineInterface['ui']['resolve']>

const ROLE_NAMES: Record<LocalRole, string> = { default: 'default', fast: 'fast', vision: 'vision', vision_best: 'vision-best', big: 'big' }
// The nickname column: the longest name, vision-best, and a gap.
const ROLE_COLUMN = 13
// The tag column of the models list.
const IMAGES_TAG = 'images'

// The runner's models as objects, whatever shape the runner reported.
function modelsOf(shown: LocalShow): LocalModel[] {
  const models: LocalModel[] = []
  for (const entry of shown.proposal?.models ?? []) {
    models.push(typeof entry === 'string' ? { id: entry } : entry)
  }
  return models
}

function findModel(models: LocalModel[], id: string): LocalModel | null {
  for (const model of models) {
    if (model.id === id) return model
  }
  return null
}

type RunnerState = 'up' | 'not running' | 'not found'

function runnerState(shown: LocalShow, runner: string): RunnerState {
  for (const probe of shown.probe) {
    if (probe.type === runner && probe.up) return 'up'
  }
  for (const configured of shown.configured) {
    if (configured.type === runner) return 'not running'
  }
  return 'not found'
}

function runnerLabel(shown: LocalShow, runner: string): string {
  const inUse = shown.in_use === runner ? ', in use' : ''
  const state = runnerState(shown, runner)
  if (state !== 'up') return `${runner} — ${state}${inUse}`
  let found = null
  for (const probe of shown.probe) {
    if (probe.type === runner && probe.up) found = probe
  }
  const key = found?.needs_key ? ', needs its key' : ''
  return `${runner} — up, ${found?.models.length ?? 0} models${key}${inUse}`
}

// Said beside a nickname only when it needs the person: a saved model gone,
// or a proposal not saved yet.
function rowNote(row: LocalRow | null): string {
  if (row === null || row.saved_state === 'kept') return ''
  if (row.saved_state === 'gone' && row.replacement !== null) return `saved ${row.saved} gone → ${row.replacement}, another quant of the same model`
  if (row.saved_state === 'gone') return `saved ${row.saved} gone`
  if (row.saved_state === 'replaced') return `saved ${row.saved} gone → ${row.replacement}, another quant of the same model`
  return row.reason
}

// The address field: a runner with no address the probe or settings know.
// Decided by the last read, not by a preview: a preview of a typed address
// answers with that address, and the field must stay while it is typed.
function needsAddress(view: LocalSetupView): boolean {
  return view.askAddress || view.fields.url !== ''
}

// The key variable field: a llama-swap that is running and asked for a key,
// or can't be read, with no variable found. A stopped one asks for nothing.
function needsKeyName(view: LocalSetupView, shown: LocalShow): boolean {
  if (view.runner !== 'llama-swap') return false
  let running = false
  for (const probe of shown.probe) {
    if (probe.type === 'llama-swap' && probe.needs_key && !probe.key_env) return true
    if (probe.type === 'llama-swap' && probe.up) running = true
  }
  return shown.reachable === false && running
}

export function drawLocalTab($: EngineInterface, table: Table, surface: string, view: LocalSetupView, width: number) {
  const { Box, Button, Text } = table
  // The mobile app draws no field yet (its table may still name them).
  if (surface === 'mobile' || !('Select' in table) || !('Input' in table)) {
    return <Text dimColor>This surface can't draw the setup form; run /consult:setlocal in a terminal, or ask Claude to set up local models.</Text>
  }
  const { Input, Select } = table
  const shown = view.shown
  const refresh = () => refreshLocal($, view.runner)

  const messages = (
    <Box flexDirection="column">
      {view.error !== null && <Text color="error">{view.error}</Text>}
      {view.savedMessage !== null && <Text color="success">✓ {view.savedMessage}</Text>}
      {(shown?.settings_warnings ?? []).map(warning => (
        <Text dimColor>{warning}</Text>
      ))}
    </Box>
  )
  if (shown === null || view.status !== 'ready') {
    let status = ''
    if (view.status === 'checking' || view.status === 'idle') status = 'checking…'
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{status}  </Text>
          <Button key="local:refresh" label="Refresh" onPress={refresh} />
        </Box>
        {messages}
      </Box>
    )
  }

  const runnerOptions: { value: string; label: string }[] = []
  for (const runner of LOCAL_RUNNERS) runnerOptions.push({ value: runner, label: runnerLabel(shown, runner) })
  let dotColor = 'inactive'
  if (view.runner !== null && runnerState(shown, view.runner) === 'up') dotColor = 'success'
  else if (view.runner !== null && runnerState(shown, view.runner) === 'not running') dotColor = 'warning'

  const models = modelsOf(shown)
  const rows = shown.proposal?.rows ?? []
  const saved = savedPicks(shown)
  // Which nicknames each model has, as picked now (saved or not).
  const nicknamesOf: Record<string, string[]> = {}
  for (const role of LOCAL_ROLES) {
    const pick = view.picks[role]
    if (nicknamesOf[pick] === undefined) nicknamesOf[pick] = []
    nicknamesOf[pick].push(ROLE_NAMES[role])
  }

  const drawRole = (role: LocalRole) => {
    let row: LocalRow | null = null
    for (const one of rows) {
      if (one.role === role) row = one
    }
    const pick = view.picks[role]
    const options: { value: string; label: string }[] = []
    const tied = row !== null && row.proposed.length > 1 ? row.proposed : []
    // In the open list: ● the saved model, ○ the one picked but not saved yet.
    const savedValue = saved[role] ?? NO_MODEL
    const marked = (value: string, text: string) => {
      let mark = '  '
      if (value === savedValue) mark = '● '
      else if (value === pick) mark = '○ '
      return { value, label: `${mark}${text}` }
    }
    for (const id of tied) options.push(marked(id, `${id} (tie)`))
    for (const model of models) {
      if (!tied.includes(model.id)) options.push(marked(model.id, model.id))
    }
    options.push(marked(NO_MODEL, 'none'))
    // A vision nickname on a model not known to read images is the one
    // image fact worth a mark.
    const picked = findModel(models, pick)
    const isVisionRole = role === 'vision' || role === 'vision_best'
    const warnImages = isVisionRole && picked !== null && picked.vision !== true
    const note = rowNote(row)
    // Picked but not saved yet: what the file holds now.
    let unsaved = ''
    if (pick !== '') {
      const savedModel = saved[role]
      const differs = pick === NO_MODEL ? savedModel !== null : pick !== savedModel
      if (differs) unsaved = savedModel === null ? '• new' : `• was ${savedModel}`
    }
    return (
      <Box flexDirection="row">
        <Select
          key={`local:role:${role}`}
          label={ROLE_NAMES[role].padEnd(ROLE_COLUMN - 1)}
          options={options}
          value={pick}
          onSelect={value => changeLocal($, { role, model: value })}
        />
        {/* The marks keep their width; on a narrow row only the dim note is cut. */}
        {warnImages && <Box flexShrink={0}><Text color="warning">  ⚠ images</Text></Box>}
        {unsaved !== '' && <Box flexShrink={0}><Text color="suggestion">  {unsaved}</Text></Box>}
        {note !== '' && <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">  {note}</Text></Box>}
      </Box>
    )
  }

  // The runner isn't running: what is saved, as text, and how to get the
  // pickers back.
  const drawSaved = () => {
    const lines = []
    for (const role of LOCAL_ROLES) {
      const model = shown.saved_nicknames?.[role] ?? null
      lines.push(<Text>{`${ROLE_NAMES[role].padEnd(ROLE_COLUMN)}${model ?? '—'}`}</Text>)
    }
    const how = shown.start ? ` (${shown.start})` : ''
    lines.push(<Text color="warning">{`${view.runner} isn't running: start it${how}, then Refresh.`}</Text>)
    return lines
  }

  // One line per model with its facts: type (MoE, dense), engine, decode
  // speed, and "images" when it reads them; a model with no facts written
  // shows its description instead. Models no nickname is picked for are dim.
  // A speed written down as is; one measured on this machine's calls with ~.
  const speedOf = (model: LocalModel) => {
    if (model.decode_tps !== undefined && model.decode_tps !== null) return `${model.decode_tps} t/s`
    if (typeof model.measured_tps === 'number') return `~${model.measured_tps} t/s`
    return ''
  }
  const hasFacts = (model: LocalModel) => Boolean(model.arch || model.engine || speedOf(model) !== '')
  const drawModels = () => {
    let idColumn = 0
    let archColumn = 0
    let engineColumn = 0
    let speedColumn = 0
    for (const model of models) {
      if (model.id.length > idColumn) idColumn = model.id.length
      if ((model.arch ?? '').length > archColumn) archColumn = (model.arch ?? '').length
      if ((model.engine ?? '').length > engineColumn) engineColumn = (model.engine ?? '').length
      if (speedOf(model).length > speedColumn) speedColumn = speedOf(model).length
    }
    const lines = []
    for (const model of models) {
      let line = model.id.padEnd(idColumn + 2)
      if (hasFacts(model)) {
        if (archColumn > 0) line += (model.arch ?? '').padEnd(archColumn + 2)
        if (engineColumn > 0) line += (model.engine ?? '').padEnd(engineColumn + 2)
        if (speedColumn > 0) line += speedOf(model).padStart(speedColumn) + '  '
        if (model.vision === true) line += IMAGES_TAG
      } else {
        line += model.description ?? ''
        if (model.vision === true && !(model.description ?? '').includes('images')) line += `  ${IMAGES_TAG}`
      }
      lines.push(<Text dimColor={nicknamesOf[model.id] === undefined} wrap="truncate-end">{line.trimEnd()}</Text>)
    }
    return lines
  }
  let anyUnused = false
  let anyMeasured = false
  for (const model of models) {
    if (nicknamesOf[model.id] === undefined) anyUnused = true
    if (speedOf(model).startsWith('~')) anyMeasured = true
  }

  const holding = shown.other_loaded ?? []
  const holdingText: string[] = []
  for (const other of holding) holdingText.push(`${other.loaded.join(', ')} from ${other.type}`)
  const blocked = saveBlocked(view)
  const notInUse = view.runner !== null && shown.in_use !== view.runner
  const canPick = rows.length > 0 || models.length > 0

  let changeStatus = ''
  if (view.previewing) changeStatus = 'checking…'
  else if (view.diff === null) changeStatus = 'No changes.'

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row">
        <Text color={dotColor}>● </Text>
        <Select key="local:runner" label="Runner" options={runnerOptions} value={view.runner ?? ''} onSelect={value => refreshLocal($, value)} />
        <Text>  </Text>
        <Button key="local:refresh" label="Refresh" onPress={refresh} />
      </Box>
      {messages}
      {shown.note !== undefined && <Text dimColor>{shown.note}</Text>}
      {needsAddress(view) && (
        <Input
          key="local:url"
          label="Address (on this machine)"
          placeholder="http://127.0.0.1:8080/v1"
          value={view.fields.url}
          onInput={text => changeLocal($, { field: 'url', text })}
          onSubmit={text => submitLocalField($, 'url', text)}
        />
      )}
      {needsKeyName(view, shown) && (
        <Input
          key="local:key_env"
          label="Key variable (its NAME, not the key)"
          placeholder="LLAMA_SWAP_API_KEY"
          value={view.fields.key_env}
          onInput={text => changeLocal($, { field: 'key_env', text })}
          onSubmit={text => submitLocalField($, 'key_env', text)}
        />
      )}
      {view.fields.key_env.trim() !== '' && !isVariableName(view.fields.key_env.trim()) && (
        <Text color="error">That isn't a variable name: type the NAME of the variable that holds the key, never the key.</Text>
      )}
      {notInUse && (
        <Box flexDirection="column">
          <Input
            key="local:start"
            label="Start note"
            placeholder={'e.g. Desktop shortcut "llama-swap"'}
            value={view.fields.start}
            onInput={text => changeLocal($, { field: 'start', text })}
            onSubmit={text => changeLocal($, { field: 'start', text })}
          />
          <Text dimColor>  shown when the runner isn't running</Text>
        </Box>
      )}
      <Text> </Text>
      <Text bold>NICKNAMES</Text>
      {canPick && LOCAL_ROLES.map(role => drawRole(role))}
      {!canPick && shown.reachable === false && drawSaved()}
      {shown.proposal?.fit_known === false && <Text dimColor>GPU memory unknown: set local_vram_mb to have models that fit proposed.</Text>}
      {notInUse && (
        <Button key="local:use" plain label={`${view.use ? '[x]' : '[ ]'} Use ${view.runner}`} onPress={() => changeLocal($, { use: !view.use })} />
      )}
      {models.length > 0 && <Text> </Text>}
      {models.length > 0 && (
        <Text>
          <Text bold>MODELS</Text>
          {anyUnused && <Text dimColor>  (dim: no nickname uses it)</Text>}
        </Text>
      )}
      {models.length > 0 && drawModels()}
      {anyMeasured && <Text dimColor>~ measured on your calls</Text>}
      <Text> </Text>
      {!view.previewing && view.diff !== null && view.diff.map(line => <Text color={line.startsWith('-') ? 'error' : 'success'}>{line}</Text>)}
      <Box flexDirection="row">
        <Button key="local:save" label="Save" dimColor={blocked} onPress={() => saveLocal($, false)} />
        {holding.length > 0 && <Text>  </Text>}
        {holding.length > 0 && (
          <Button
            key="local:save-unload"
            label={`Save and unload ${holdingText.join('; ')}`}
            dimColor={blocked}
            onPress={() => saveLocal($, true)}
          />
        )}
        {changeStatus !== '' && <Text dimColor>  {changeStatus}</Text>}
      </Box>
    </Box>
  )
}
