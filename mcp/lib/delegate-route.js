// Routing words for delegate: which worker a task goes to, from the first word
// of the request or from the kind of work, plus the default table lookup.

import { NICKNAME_SPELLINGS } from './local-models.js';

// Other names for a worker, for the tool description and the command file.
export const WORKER_ALIASES = Object.freeze({
  gpt: 'codex',
  openai: 'codex',
  gemini: 'agy',
  argon: 'agy',
  qwen: 'local',
  llama: 'local',
  offline: 'local'
});

const WORKER_NAMES = ['codex', 'agy', 'local'];
const TABLE_KINDS = ['code', 'research', 'review', 'private'];
const LOCAL_NICKNAME_PREFIX = 'local:';

// One word (a worker name, an alias, or `local:<nickname>`, any case) to
// { worker, nickname }. Any other word, `auto` included, gives
// { worker: null, nickname: null }: a caller that accepts `auto` checks for it
// before asking. A `local:` word whose nickname is not one of consult's local
// nicknames (default, fast, vision, vision-best, big) throws, so a path or
// other junk never reaches the local runner.
export function parseWorkerWord(word) {
  if (typeof word !== 'string') return { worker: null, nickname: null };
  const lowered = word.toLowerCase();
  if (lowered.startsWith(LOCAL_NICKNAME_PREFIX)) {
    const nickname = lowered.slice(LOCAL_NICKNAME_PREFIX.length);
    if (!Object.hasOwn(NICKNAME_SPELLINGS, nickname)) {
      throw new Error(`\`${nickname}\` is not a local model nickname (use ${Object.keys(NICKNAME_SPELLINGS).join(', ')}).`);
    }
    return { worker: 'local', nickname };
  }
  if (WORKER_NAMES.includes(lowered)) return { worker: lowered, nickname: null };
  if (Object.hasOwn(WORKER_ALIASES, lowered)) return { worker: WORKER_ALIASES[lowered], nickname: null };
  return { worker: null, nickname: null };
}

// The worker the table names for a kind of work, or null for `other` (the
// caller then asks which worker). `table` is settings.delegate.table.
export function workerForKind(kind, table) {
  if (kind === 'other') return null;
  if (!TABLE_KINDS.includes(kind)) {
    throw new Error(`Unknown kind \`${kind}\` (use ${[...TABLE_KINDS, 'other'].join(', ')}).`);
  }
  return table[kind];
}
