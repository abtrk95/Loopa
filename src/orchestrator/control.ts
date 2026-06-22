/**
 * Control plane. The watcher (or `pause`/`resume`/`stop` commands) write a desired
 * state into a small JSON file; the engine reads it at checkpoints. The watcher
 * NEVER edits run state directly — it only expresses intent here, and the engine
 * (the sole state owner) acts on it. This keeps the watcher strictly read-only
 * with respect to authoritative state.
 */
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { atomicWriteJson, readJson, PRIVATE_FILE_MODE } from '../util/fs.js';

export type DesiredState = 'run' | 'paused' | 'stopped';

interface ControlFile {
  desired: DesiredState;
  ts: number;
}

export class ControlPlane {
  private readonly file: string;
  constructor(controlDir: string) {
    this.file = join(controlDir, 'control.json');
  }

  /**
   * Reset the control plane to the neutral 'run' state by removing any stale intent
   * file. Called once when an engine starts/resumes so a leftover 'stopped'/'paused'
   * from a PRIOR process (e.g. a `stop` issued after a run already finished) cannot
   * silently sabotage a fresh run. Live control during the run still works — those
   * intents are written after this reset.
   */
  clear(): void {
    try {
      if (existsSync(this.file)) unlinkSync(this.file);
    } catch {
      // best effort; a corrupt/unreadable file is treated as 'run' by getDesired()
    }
  }

  getDesired(): DesiredState {
    if (!existsSync(this.file)) return 'run';
    try {
      const data = readJson<ControlFile>(this.file);
      return data.desired ?? 'run';
    } catch {
      return 'run';
    }
  }

  private set(desired: DesiredState, nowMs: number): void {
    atomicWriteJson(this.file, { desired, ts: nowMs } satisfies ControlFile, { mode: PRIVATE_FILE_MODE });
  }

  requestPause(nowMs: number): void {
    this.set('paused', nowMs);
  }
  requestResume(nowMs: number): void {
    this.set('run', nowMs);
  }
  requestStop(nowMs: number): void {
    this.set('stopped', nowMs);
  }
}
