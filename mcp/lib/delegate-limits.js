// What consult learns about the plan usage limits of codex and agy, and the
// policy it makes of that: ok, warn at 90 % of a window, full at 100 % or
// after a hit. Claude uses the policy to warn before it starts a task near a
// limit.
//
// <data>/limits.json holds, in epoch milliseconds throughout:
//   usage  { <worker>: { windows: [{ minutes, used_percent, resets_at }], at } }
//   hits   { <worker>: { hit_at, resets_at, kind } }   kind 'exhausted' | 'throttled'; resets_at is null when unknown
// Written the way the task store writes (temp file, rename), last writer
// wins; a missing or corrupt file is read as empty.

import fs from 'node:fs';
import path from 'node:path';
import { dataHome, writeJsonAtomic, readJsonOrNull } from './delegate-store.js';
import { codexHome } from './codex.js';

const MINUTE_MS = 60000;
const STALE_AFTER_MS = 30 * MINUTE_MS;
const WARN_AT_PERCENT = 90;
const FULL_AT_PERCENT = 100;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10080;
// Rollout files are read newest first until one has rate limits; a session
// that has not counted tokens yet has none.
const MAX_ROLLOUTS_READ = 10;
const TAIL_BYTES = 256 * 1024;
const WIDE_TAIL_BYTES = 4 * 1024 * 1024;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// What each kind of hit means. holdUnknownResetMs: a hit with no reset time counts
// against its worker for this long (a throttled hit, a 429, passes in seconds).
// level: what the policy says while the hit holds. pausedPhrase: how a paused task's
// summary says it. policyNote: the hit as a line of the policy's note.
const HIT_KINDS = Object.freeze({
  exhausted: Object.freeze({
    holdUnknownResetMs: 60 * MINUTE_MS,
    level: 'full',
    pausedPhrase: 'hit its usage limit',
    policyNote: (worker, hit, now) => (
      hit.resets_at === null
        ? `${worker} hit its limit ${agoText(now - hit.hit_at)}; reset unknown`
        : `${worker} hit its limit; ${resetText(hit.resets_at, now)}`
    )
  }),
  throttled: Object.freeze({
    holdUnknownResetMs: 5 * MINUTE_MS,
    level: 'warn',
    pausedPhrase: 'was rate limited',
    policyNote: (worker, hit, now) => `${worker} was rate limited ${agoText(now - hit.hit_at)}`
  })
});

// The kind's entry in HIT_KINDS; a kind that is not known is 'exhausted'.
export function hitKindOf(kind) {
  return kind === 'throttled' ? HIT_KINDS.throttled : HIT_KINDS.exhausted;
}

function normalHitKind(kind) {
  return kind === 'throttled' ? 'throttled' : 'exhausted';
}

// ---- limits.json ----

function limitsFilePath() {
  return path.join(dataHome(), 'limits.json');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLimitsFile() {
  const empty = { usage: {}, hits: {} };
  try {
    const parsed = readJsonOrNull(limitsFilePath());
    if (!isPlainObject(parsed)) return empty;
    return { usage: isPlainObject(parsed.usage) ? parsed.usage : {}, hits: isPlainObject(parsed.hits) ? parsed.hits : {} };
  } catch (_) {
    return empty;
  }
}

// The usage windows of codex's own `{ primary, secondary }` shape (their
// resets_at in epoch seconds) as [{ minutes, used_percent, resets_at }] with
// resets_at in ms. A window that is missing or null is skipped.
function windowsOfCodexLimit(limit) {
  const windows = [];
  for (const name of ['primary', 'secondary']) {
    const each = limit?.[name];
    if (!each || typeof each.used_percent !== 'number') continue;
    windows.push({
      minutes: typeof each.window_minutes === 'number' ? each.window_minutes : null,
      used_percent: each.used_percent,
      resets_at: typeof each.resets_at === 'number' ? each.resets_at * 1000 : null
    });
  }
  return windows;
}

// Records what a run learned about the plan's usage windows: `limit` is codex's
// `{ primary, secondary }` as its rollout file has it. A limit with no window
// teaches nothing and leaves what is known.
export function recordLimit(worker, limit, at) {
  const windows = windowsOfCodexLimit(limit);
  if (windows.length === 0) return;
  const data = readLimitsFile();
  data.usage[worker] = { windows, at };
  writeJsonAtomic(limitsFilePath(), data);
}

// Records that a worker hit its limit: `hit` is { kind, resets_at } with
// resets_at in ms or null.
export function recordLimitHit(worker, hit, at) {
  const data = readLimitsFile();
  data.hits[worker] = {
    hit_at: at,
    resets_at: typeof hit?.resets_at === 'number' ? hit.resets_at : null,
    kind: normalHitKind(hit?.kind)
  };
  writeJsonAtomic(limitsFilePath(), data);
}

// ---- reading them back ----

function recordedReading(entry) {
  if (!isPlainObject(entry) || !Array.isArray(entry.windows) || typeof entry.at !== 'number') return null;
  const windows = [];
  for (const each of entry.windows) {
    if (!isPlainObject(each) || typeof each.used_percent !== 'number') continue;
    windows.push({
      minutes: typeof each.minutes === 'number' ? each.minutes : null,
      used_percent: each.used_percent,
      resets_at: typeof each.resets_at === 'number' ? each.resets_at : null
    });
  }
  return windows.length === 0 ? null : { windows, at: entry.at };
}

function recordedHit(entry) {
  if (!isPlainObject(entry) || typeof entry.hit_at !== 'number') return null;
  return {
    hit_at: entry.hit_at,
    resets_at: typeof entry.resets_at === 'number' ? entry.resets_at : null,
    kind: normalHitKind(entry.kind)
  };
}

function twoDigits(number) {
  return String(number).padStart(2, '0');
}

// The `rate_limits` of the last token_count event in a rollout file's text,
// as codex wrote it, or null when there is none.
export function lastRateLimitsIn(rolloutText) {
  let rateLimits = null;
  for (const line of rolloutText.split(/\r?\n/)) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'event_msg' && event.payload?.type === 'token_count' && event.payload.rate_limits) {
        rateLimits = event.payload.rate_limits;
      }
    } catch (_) {}
  }
  return rateLimits;
}

// The text of the last `bytes` bytes of a file, from the start of its first
// whole line (the chunk's first line is usually cut, so it is dropped), and
// whether that is the whole file. A rollout can be hundreds of MB; it is never
// read whole.
function readTail(file, bytes) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const count = fs.readSync(descriptor, buffer, filled, buffer.length - filled, start + filled);
      if (count === 0) break;
      filled += count;
    }
    let text = buffer.toString('utf8', 0, filled);
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return { text, isWholeFile: start === 0 };
  } finally {
    fs.closeSync(descriptor);
  }
}

// The last rate_limits in a rollout file, looked for in its last 256 KB and,
// if not there, once more in its last 4 MB; null when still none.
export function rateLimitsFromTail(file) {
  for (const bytes of [TAIL_BYTES, WIDE_TAIL_BYTES]) {
    const tail = readTail(file, bytes);
    const rateLimits = lastRateLimitsIn(tail.text);
    if (rateLimits !== null) return rateLimits;
    if (tail.isWholeFile) return null;
  }
  return null;
}

// The usage windows in the newest codex rollout file of yesterday, today or
// tomorrow (local dates, as of `now`), with the file's modification time as
// the time of the reading. The user's own interactive codex use counts against
// the same plan, so this is the best current figure when no delegate run
// recorded one. Tomorrow's folder is a hedge: whether codex names the folders
// by local or UTC date is not verified. A session started more than a day ago
// and still in use is in an older folder and is not seen.
function newestRolloutReading(now) {
  const rollouts = [];
  for (const daysBack of [-1, 0, 1]) {
    const day = new Date(now);
    day.setDate(day.getDate() - daysBack);
    const folder = path.join(codexHome(), 'sessions', String(day.getFullYear()), twoDigits(day.getMonth() + 1), twoDigits(day.getDate()));
    let names = [];
    try { names = fs.readdirSync(folder); } catch (_) { /* no sessions that day */ }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(folder, name);
      try {
        rollouts.push({ file, modifiedAt: Math.round(fs.statSync(file).mtimeMs) });
      } catch (_) { /* gone meanwhile */ }
    }
  }
  rollouts.sort((first, second) => second.modifiedAt - first.modifiedAt);
  for (const rollout of rollouts.slice(0, MAX_ROLLOUTS_READ)) {
    let rateLimits;
    try { rateLimits = rateLimitsFromTail(rollout.file); } catch (_) { continue; }
    const windows = windowsOfCodexLimit(rateLimits);
    if (windows.length > 0) return { windows, at: rollout.modifiedAt };
  }
  return null;
}

// What is known as of `now`:
//   codex  { windows, at, stale, hit } or null; `hit` is { hit_at, resets_at } or null
//   agy    { hit_at, resets_at } or null
//   local  { hit_at, resets_at } or null
// codex's windows are the newest of the recorded reading and, when that is
// missing or over 30 min old, the newest codex rollout. `stale` says the
// newest reading is over 30 min old.
export function lastLimits(now) {
  const data = readLimitsFile();
  let reading = recordedReading(data.usage.codex);
  if (reading === null || now - reading.at > STALE_AFTER_MS) {
    const fromRollout = newestRolloutReading(now);
    if (fromRollout !== null && (reading === null || fromRollout.at > reading.at)) reading = fromRollout;
  }
  const codexHit = recordedHit(data.hits.codex);
  let codex = null;
  if (reading !== null || codexHit !== null) {
    codex = {
      windows: reading === null ? [] : reading.windows,
      at: reading === null ? null : reading.at,
      stale: reading !== null && now - reading.at > STALE_AFTER_MS,
      hit: codexHit
    };
  }
  return { codex, agy: recordedHit(data.hits.agy), local: recordedHit(data.hits.local) };
}

// ---- the policy ----

function windowName(minutes) {
  if (minutes === FIVE_HOUR_MINUTES) return '5-hour';
  if (minutes === WEEKLY_MINUTES) return 'weekly';
  return minutes === null ? 'usage' : `${minutes}-minute`;
}

function clockTime(timeMs, now) {
  const time = new Date(timeMs);
  const clock = `${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`;
  return time.toDateString() === new Date(now).toDateString() ? clock : `${DAY_NAMES[time.getDay()]} ${clock}`;
}

function waitText(durationMs) {
  const totalMinutes = Math.max(1, Math.round(durationMs / MINUTE_MS));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

// "40 min ago", "3 h ago" past 90 min, "3 days ago" past 48 h.
function agoText(ageMs) {
  const minutes = Math.max(0, Math.round(ageMs / MINUTE_MS));
  if (minutes <= 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours <= 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function resetText(resetsAt, now) {
  return `resets ${clockTime(resetsAt, now)} (in about ${waitText(resetsAt - now)})`;
}

// Whether a worker's recorded hit still holds at `now`: its reset is ahead, or
// is unknown and the hit is under an hour old (under 5 min for a throttled hit). For codex a later reading of
// the windows supersedes the hit: it shows what the plan has now.
function activeHit(worker, limits, now) {
  const hit = worker === 'codex' ? limits.codex?.hit : limits[worker];
  if (!isPlainObject(hit) || typeof hit.hit_at !== 'number') return null;
  if (worker === 'codex' && typeof limits.codex.at === 'number' && limits.codex.at > hit.hit_at) return null;
  if (typeof hit.resets_at === 'number') return hit.resets_at > now ? hit : null;
  return now - hit.hit_at < hitKindOf(hit.kind).holdUnknownResetMs ? hit : null;
}

// { level: 'ok' | 'warn' | 'full', note } for starting a task on `worker`,
// from lastLimits' result. The note is '' when the level is ok.
export function limitPolicy(worker, limits, now) {
  if (!isPlainObject(limits)) return { level: 'ok', note: '' };
  let level = 'ok';
  const notes = [];

  const windows = worker === 'codex' && Array.isArray(limits.codex?.windows) ? limits.codex.windows : [];
  for (const window of windows) {
    if (window.resets_at !== null && window.resets_at <= now) continue; // that window has reset
    // With no reset time known, a window has reset once a whole window's length has passed since the reading.
    if (window.resets_at === null && window.minutes !== null && limits.codex.at + window.minutes * MINUTE_MS < now) continue;
    if (window.used_percent < WARN_AT_PERCENT) continue;
    if (window.used_percent >= FULL_AT_PERCENT) level = 'full';
    else if (level === 'ok') level = 'warn';
    const reset = window.resets_at === null ? 'reset time unknown' : resetText(window.resets_at, now);
    const advice = window.minutes === WEEKLY_MINUTES ? '; use another worker rather than waiting' : '';
    notes.push(`${worker} ${windowName(window.minutes)} window is ${Math.round(window.used_percent)}% used; ${reset}${advice}`);
  }
  if (notes.length > 0 && limits.codex.stale) {
    notes[notes.length - 1] += ` (figures from ${agoText(now - limits.codex.at)})`;
  }

  // A hit says more than the windows only when they do not already read full.
  const hit = level === 'full' ? null : activeHit(worker, limits, now);
  if (hit !== null) {
    const hitKind = hitKindOf(hit.kind);
    if (hitKind.level === 'full' || level === 'ok') level = hitKind.level;
    notes.push(hitKind.policyNote(worker, hit, now));
  }
  return { level, note: notes.join('. ') };
}
