/**
 * Crash-safe filesystem helpers. Writes are atomic (write to a temp file in the
 * same directory, fsync, then rename) so a crash mid-write never leaves a
 * truncated file. All paths are absolute and platform-correct via node:path.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

/** Atomically write a string to `path`, creating parent dirs as needed. */
export function atomicWrite(path: string, contents: string): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `.${Math.abs(hash(path + contents.length))}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Append a line (NDJSON-friendly), creating the file/dir if needed. */
export function appendLine(path: string, line: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, line.endsWith('\n') ? line : line + '\n', { flag: 'a' });
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
