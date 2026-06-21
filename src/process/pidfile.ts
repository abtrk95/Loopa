/**
 * Single-writer run lock (PID file) with stale-lock detection.
 *
 * The event store is the canonical single-writer of run state; this lock adds an
 * OS-level guard so two `agent-loop run`/`retry` processes don't drive the same
 * project concurrently. Crucially it is SELF-HEALING: if a prior orchestrator was
 * hard-killed (`kill -9`) and never released the lock, the next run detects the
 * holder PID is dead and takes over — a stale lock never permanently bricks a run.
 *
 * Honest OS limitations:
 *  - PIDs are reused by the OS. A stale PID could, in theory, be re-used by an
 *    unrelated process; we additionally record the runId so a takeover only ever
 *    reclaims OUR project's lock, and the deterministic verifier + git reconcile
 *    remain the real integrity guarantees.
 *  - On Windows `process.kill(pid, 0)` liveness probing works, but there is no
 *    process group; orphan reaping uses `taskkill /T` (see process/manager.ts).
 */
import { existsSync, unlinkSync } from 'node:fs';
import { atomicWriteJson, readJson, PRIVATE_FILE_MODE } from '../util/fs.js';
import { isProcessAlive } from './manager.js';

export interface RunLock {
  pid: number;
  runId: string;
  startedAt: number;
}

export type AcquireResult =
  | { ok: true; takeover: 'fresh' | 'stale' | 'self' }
  | { ok: false; holder: RunLock };

export function readRunLock(path: string): RunLock | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const lock = readJson<RunLock>(path);
    if (typeof lock.pid === 'number' && typeof lock.runId === 'string') return lock;
    return undefined;
  } catch {
    return undefined; // corrupt/garbage lock → treat as absent (will be overwritten)
  }
}

/**
 * Try to acquire the lock for `runId`. Returns `ok:false` with the live holder if
 * another running process owns it; otherwise writes our lock and reports whether it
 * was fresh, a takeover of a stale (dead-holder) lock, or re-entrant (our own pid).
 */
export function acquireRunLock(path: string, runId: string, nowMs: number, pid = process.pid): AcquireResult {
  const existing = readRunLock(path);
  if (existing) {
    if (existing.pid === pid) {
      write(path, { pid, runId, startedAt: nowMs });
      return { ok: true, takeover: 'self' };
    }
    if (isProcessAlive(existing.pid)) {
      return { ok: false, holder: existing };
    }
    // Holder is dead → stale lock from a crashed/hard-killed run. Reclaim it.
    write(path, { pid, runId, startedAt: nowMs });
    return { ok: true, takeover: 'stale' };
  }
  write(path, { pid, runId, startedAt: nowMs });
  return { ok: true, takeover: 'fresh' };
}

/** Release the lock if we (this pid) hold it. Safe to call when absent. */
export function releaseRunLock(path: string, pid = process.pid): void {
  const existing = readRunLock(path);
  if (!existing || existing.pid !== pid) return;
  try {
    unlinkSync(path);
  } catch {
    // best effort — a leftover lock is self-healed on the next run
  }
}

function write(path: string, lock: RunLock): void {
  atomicWriteJson(path, lock, { mode: PRIVATE_FILE_MODE });
}
