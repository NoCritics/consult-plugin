// Decode speeds measured on this machine's own local calls, so the Local
// models tab can show a speed for a model nobody wrote one down for. Kept in
// ~/.claude/consult-speeds.json: the last few per runner and model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = 5;

function speedsPath(home) {
  return path.join(home, '.claude', 'consult-speeds.json');
}

function readSpeeds(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(speedsPath(home), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// Keeps one call's speed. Never throws: a speed is a nicety, not the call.
export function recordSpeed({ home = os.homedir(), runner, model, tps }) {
  if (typeof tps !== 'number' || !(tps > 0) || typeof runner !== 'string' || typeof model !== 'string') return;
  try {
    const speeds = readSpeeds(home);
    const key = `${runner} ${model}`;
    const seen = Array.isArray(speeds[key]) ? speeds[key] : [];
    seen.push(tps);
    speeds[key] = seen.slice(-KEEP);
    fs.writeFileSync(speedsPath(home), JSON.stringify(speeds, null, 1));
  } catch (_) {}
}

// The median of the speeds kept for a model, rounded, or null.
export function measuredSpeed({ home = os.homedir(), runner, model }) {
  const seen = readSpeeds(home)[`${runner} ${model}`];
  if (!Array.isArray(seen)) return null;
  const numbers = [];
  for (const value of seen) {
    if (typeof value === 'number' && value > 0) numbers.push(value);
  }
  if (numbers.length === 0) return null;
  numbers.sort((a, b) => a - b);
  const middle = Math.floor(numbers.length / 2);
  const median = numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
  return Math.round(median);
}
