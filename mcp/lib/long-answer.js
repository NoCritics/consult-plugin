import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// A very long answer goes to a file. Claude Code refuses a tool result over
// about 25,000 tokens and saves it as JSON with the whole answer on one line,
// which is hard to read back. Past LONG_ANSWER_BYTES the full answer is saved
// as Markdown and the result carries its start and the path instead. Bytes,
// not characters: a character of Chinese or Japanese is about one token.
export const LONG_ANSWER_BYTES = 40000;
export const PREVIEW_CHARS = 8000;
// The folder keeps this many answers; older ones are removed.
export const KEEP_ANSWERS = 100;
// Only files consult wrote: an ISO time, the tool, the model, a random tag.
const ANSWER_FILE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-.+-[0-9a-f]{6}\.md$/;

export function answersDir() {
  return path.join(os.homedir(), '.claude', 'consult-answers');
}

export function isLongText(text) {
  return typeof text === 'string' && Buffer.byteLength(text, 'utf8') > LONG_ANSWER_BYTES;
}

// The start of a long text and where the whole of it is.
export function previewWithPath(text, filePath) {
  return `${text.slice(0, PREVIEW_CHARS)}\n\n[The answer continues: ${text.length} characters in all. The full answer is in ${filePath}. Read it there, in parts.]`;
}

function safeNamePart(text) {
  return String(text ?? 'default').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
}

function removeOldAnswers(dir) {
  const names = [];
  for (const name of fs.readdirSync(dir)) {
    if (ANSWER_FILE_NAME.test(name)) names.push(name);
  }
  // Names start with an ISO time, so sorting them sorts by age.
  names.sort();
  for (let index = 0; index < names.length - KEEP_ANSWERS; index += 1) {
    try { fs.unlinkSync(path.join(dir, names[index])); } catch (_) { /* gone or locked: leave it */ }
  }
}

// Returns the result unchanged when the answer is short, or when it can't be
// saved (Claude Code then keeps it its own way); otherwise saves the full
// answer and returns the result with its start, the path and the length.
export function spillLongAnswer(result, tool, { dir = answersDir(), now = new Date() } = {}) {
  if (!isLongText(result?.response)) return result;
  const filePath = path.join(dir, `${now.toISOString().replace(/[:.]/g, '-')}-${safeNamePart(tool)}-${safeNamePart(result.model)}-${randomBytes(3).toString('hex')}.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, `<!-- consult ${tool} · ${result.model ?? 'default'} · ${now.toISOString()} -->\n\n${result.response}`, 'utf8');
  } catch (error) {
    process.stderr.write(`[consult] could not save a long answer to ${filePath}: ${error.message}\n`);
    return result;
  }
  try { removeOldAnswers(dir); } catch (_) { /* the answer is saved; old ones stay */ }
  return { ...result, response: previewWithPath(result.response, filePath), full_answer_path: filePath, response_chars: result.response.length };
}
