import type { DelegateWatch, DelegatedView, Health, LocalSetupView, PaneView } from '../../types'

// Initial values of the mod's session values ($.state, declared in
// types/index.d.ts). Each file that reads or writes one declares its own
// atom for it, with these keys: the engine lists a module's state reads and
// writes from atoms created in the file that uses them.

// The consult pane's id: the pane, and the modules that ask whether it is open.
export const PANE_ID = 'consult'

export const INITIAL_HEALTH: Health = {
  services: {
    codex: { state: 'unknown', reason: null },
    agy: { state: 'unknown', reason: null },
    local: { state: 'absent', reason: null },
  },
  showStartLine: false,
}

export const INITIAL_PANE: PaneView = { tab: 'answers', expandedId: null, sessionShown: 10, earlierShown: 10 }

export const INITIAL_DELEGATE: DelegateWatch = { owned: [], elsewhere: [], earlierSessions: [], band: [] }

export const INITIAL_DELEGATED: DelegatedView = {
  status: 'idle',
  error: null,
  shown: null,
  selectedId: null,
  confirm: null,
  busy: {},
  isFoldOpen: false,
  edits: {},
  saving: false,
  globalWritten: false,
  savedMessage: null,
  seq: 0,
}

export const INITIAL_LOCAL: LocalSetupView = {
  status: 'idle',
  error: null,
  shown: null,
  runner: null,
  picks: { default: '', fast: '', vision: '', vision_best: '', big: '' },
  fields: { url: '', key_env: '', start: '' },
  use: false,
  askAddress: false,
  diff: null,
  previewing: false,
  changeSeq: 0,
  saving: false,
  backedUp: false,
  savedMessage: null,
}
