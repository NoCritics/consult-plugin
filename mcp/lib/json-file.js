// Small file helpers with no consult imports: the task-id format, a sync sleep, and JSON files
// written by rename so a reader never sees half a file. The store re-exports them.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TASK_ID_PATTERN = /^[0-9a-f]{6}$/;
const RENAME_PATIENCE_MS = 5000;
const RENAME_RETRY_MS = 5;

// Whether this is the format of a task id (the name of its folder). An id outside it never reaches a path.
export function isTaskId(id) {
  return typeof id === 'string' && TASK_ID_PATTERN.test(id);
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function lockLostError() {
  return Object.assign(new Error('The lock was taken over while it was held.'), { code: 'ELOCKLOST' });
}

// Windows refuses a rename while another process (a virus scanner, a reader)
// has the target open. A reader looping on the file every few ms held a
// rename off for up to 2.3 s in a trial, so retry for up to RENAME_PATIENCE_MS.
// `stillOwned`, when given, is asked right before each rename: a writer whose
// lock was taken over writes nothing (ELOCKLOST).
export function writeFileAtomic(filePath, text, stillOwned = null) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, text);
  const giveUpAt = Date.now() + RENAME_PATIENCE_MS;
  while (true) {
    if (stillOwned !== null && !stillOwned()) {
      fs.rmSync(tempPath, { force: true });
      throw lockLostError();
    }
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      const isTransient = error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES';
      if (!isTransient || Date.now() >= giveUpAt) {
        fs.rmSync(tempPath, { force: true });
        throw error;
      }
      sleepSync(RENAME_RETRY_MS);
    }
  }
}

export function writeJsonAtomic(filePath, value, stillOwned = null) {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n', stillOwned);
}

// The parsed file, or null when it does not exist.
export function readJsonOrNull(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}
