/**
 * Crash-safe filesystem helpers. Writes are atomic (write to a temp file in the
 * same directory, fsync, then rename) so a crash mid-write never leaves a
 * truncated file. All paths are absolute and platform-correct via node:path.
 *
 * Helpers accept an optional POSIX file mode so callers can keep sensitive run
 * state private (owner-only). The mode is enforced with an explicit chmod after
 * the write/rename (open() honours the umask, which could otherwise loosen it).
 * On Windows POSIX permission bits are not enforced, so chmod is a documented
 * no-op there (see docs/security-model.md).
 */
import {
  chmodSync,
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

/** Owner-read/write only — for sensitive run-state files. */
export const PRIVATE_FILE_MODE = 0o600;
/** Owner-only directory — walls off everything inside from other local users. */
export const PRIVATE_DIR_MODE = 0o700;

export interface WriteOptions {
  /** POSIX file mode to enforce after writing (no-op on Windows). */
  mode?: number;
}

/** chmod that never throws and is a deliberate no-op on Windows. */
export function chmodSafe(path: string, mode: number): void {
  if (process.platform === 'win32') return; // POSIX perms aren't enforced on win32
  try {
    chmodSync(path, mode);
  } catch {
    // best effort — a failed chmod must never crash the engine
  }
}

export function ensureDir(dir: string, opts: { mode?: number } = {}): void {
  mkdirSync(dir, { recursive: true });
  if (opts.mode !== undefined) chmodSafe(dir, opts.mode);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

/** Atomically write a string to `path`, creating parent dirs as needed. */
export function atomicWrite(path: string, contents: string, opts: WriteOptions = {}): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `.${Math.abs(hash(path + contents.length))}.tmp`);
  const fd = openSync(tmp, 'w', opts.mode ?? 0o666);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (opts.mode !== undefined) chmodSafe(path, opts.mode);
}

export function atomicWriteJson(path: string, value: unknown, opts: WriteOptions = {}): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + '\n', opts);
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Append a line (NDJSON-friendly), creating the file/dir if needed. When `mode`
 * is set it is applied to a freshly-created file (existing files keep their mode). */
export function appendLine(path: string, line: string, opts: WriteOptions = {}): void {
  ensureDir(dirname(path));
  const isNew = opts.mode !== undefined && !existsSync(path);
  writeFileSync(path, line.endsWith('\n') ? line : line + '\n', { flag: 'a' });
  if (isNew) chmodSafe(path, opts.mode!);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
