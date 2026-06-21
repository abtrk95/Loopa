/**
 * Subprocess manager. Every external command (git, project checks, provider CLIs)
 * runs through here. Guarantees:
 *  - shell-free execution (no injection),
 *  - detached process GROUPS so timeouts/cancellation kill child trees (POSIX);
 *    on Windows, `taskkill /T` reaps the tree instead (no POSIX groups exist),
 *  - graceful SIGTERM then forced SIGKILL after a grace period,
 *  - bounded output buffers (no unbounded memory growth),
 *  - secret redaction on all captured output,
 *  - filtered environment (no git-poisoning vars).
 */
import { spawn, spawnSync } from 'node:child_process';
import { ProcessError, TimeoutError } from '../domain/errors.js';
import { Redactor } from '../security/redact.js';
import { filterEnv } from '../security/env.js';
import { resolveCommand } from './command.js';
import type { CommandSpec } from '../domain/schemas.js';

export interface RunOptions {
  cwd: string;
  /** Extra env merged over the filtered base env. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Grace before SIGKILL after SIGTERM on timeout/cancel. */
  graceMs?: number;
  /** Max bytes captured per stream before truncation. */
  maxOutputBytes?: number;
  /** Data written to the child's stdin, then closed. */
  input?: string;
  redactor?: Redactor;
  /**
   * Skip redaction of captured output. ONLY for internal reads whose result is fed to
   * deterministic scanners (e.g. the secret/test-weakening diff scans) and never
   * persisted or displayed raw — redaction there would hide the very secrets the
   * scanner must detect. Never set this for provider/agent output.
   */
  noRedact?: boolean;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  command: string;
  file: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  pid: number | undefined;
  ok: boolean;
}

/** Options for a long-running (server) child managed by `spawnServer`. */
export interface ServerOptions {
  cwd: string;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  redactor?: Redactor;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

/** Handle to a long-running child (e.g. an app server under browser verification). */
export interface ServerHandle {
  readonly pid: number | undefined;
  /** Resolves when the child exits (after stop() or on its own). */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** True until the child has exited. */
  running(): boolean;
  /** Captured stdout/stderr so far (bounded + redacted). */
  output(): { stdout: string; stderr: string };
  /** Terminate the child and its tree (POSIX group / Windows taskkill /T):
   * SIGTERM, then SIGKILL after `graceMs`. Always resolves once the child exits. */
  stop(graceMs?: number): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT = 2_000_000; // 2 MB per stream

const supportsGroups = process.platform !== 'win32';

/**
 * Best-effort termination of a child and everything it spawned. On POSIX we signal
 * the negative pid (the detached process GROUP); on Windows there are no process
 * groups, so we use `taskkill /T` to walk and kill the tree (SIGKILL → `/F`).
 */
export function terminateTree(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (supportsGroups) {
      process.kill(-pid, sig);
    } else {
      const args = sig === 'SIGKILL' ? ['/pid', String(pid), '/T', '/F'] : ['/pid', String(pid), '/T'];
      spawnSync('taskkill', args, { stdio: 'ignore' });
    }
  } catch {
    // already gone, or insufficient permission — best effort
  }
}

/** Is a process with this pid currently alive (signal 0 probe)? */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it → still "alive".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

class BoundedBuffer {
  private chunks: string[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(s: string): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const remaining = this.max - this.size;
    if (s.length > remaining) {
      this.chunks.push(s.slice(0, remaining));
      this.size = this.max;
      this.truncated = true;
    } else {
      this.chunks.push(s);
      this.size += s.length;
    }
  }
  value(): string {
    return this.chunks.join('');
  }
}

/** Tracks live children so a controller can terminate them all on stop. */
export class ProcessManager {
  private readonly active = new Set<number>();

  async run(spec: CommandSpec, opts: RunOptions): Promise<RunResult> {
    const argv = resolveCommand(spec);
    const redactor = opts.redactor ?? new Redactor();
    const apply = opts.noRedact ? (s: string): string => s : (s: string): string => redactor.redact(s);
    const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const { env: baseEnv } = filterEnv(process.env);
    const env = { ...baseEnv, ...(opts.env ?? {}) };

    const started = performance.now();
    const stdout = new BoundedBuffer(maxOutput);
    const stderr = new BoundedBuffer(maxOutput);

    const child = spawn(argv.file, argv.args, {
      cwd: opts.cwd,
      env,
      detached: supportsGroups,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pid = child.pid;
    if (pid !== undefined) this.active.add(pid);

    let timedOut = false;
    let cancelled = false;

    const killGroup = (sig: NodeJS.Signals): void => {
      if (pid === undefined) {
        child.kill(sig);
        return;
      }
      terminateTree(pid, sig);
    };

    let killTimer: NodeJS.Timeout | undefined;
    const scheduleForceKill = (): void => {
      killTimer = setTimeout(() => killGroup('SIGKILL'), graceMs);
      killTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      scheduleForceKill();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const onAbort = (): void => {
      cancelled = true;
      killGroup('SIGTERM');
      scheduleForceKill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      const red = apply(d);
      stdout.push(red);
      opts.onOutput?.('stdout', red);
    });
    child.stderr.on('data', (d: string) => {
      const red = apply(d);
      stderr.push(red);
      opts.onOutput?.('stderr', red);
    });

    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }

    return await new Promise<RunResult>((resolve, reject) => {
      child.on('error', (err) => {
        cleanup();
        if (pid !== undefined) this.active.delete(pid);
        reject(new ProcessError(`failed to spawn ${argv.file}`, { cause: err, details: { command: argv.display } }));
      });
      child.on('close', (code, signal) => {
        cleanup();
        if (pid !== undefined) this.active.delete(pid);
        const durationMs = Math.round(performance.now() - started);
        const truncated = stdout.truncated || stderr.truncated;
        const result: RunResult = {
          command: argv.display,
          file: argv.file,
          args: argv.args,
          exitCode: code,
          signal: signal,
          stdout: stdout.value(),
          stderr: stderr.value(),
          timedOut,
          cancelled,
          truncated,
          durationMs,
          pid,
          ok: code === 0 && !timedOut && !cancelled,
        };
        if (timedOut) {
          reject(
            new TimeoutError(`command timed out after ${timeoutMs}ms: ${argv.display}`, {
              durationMs,
              command: argv.display,
            }),
          );
          return;
        }
        resolve(result);
      });
      function cleanup(): void {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      }
    });
  }

  /**
   * Spawn a long-running child (e.g. an app server) and return a handle to manage
   * its lifecycle. Unlike `run`, this does NOT await the child's exit — the caller
   * probes/uses it and then calls `handle.stop()`. The child is started in its own
   * detached group (POSIX) so `stop()` can reap the whole tree.
   */
  spawnServer(spec: CommandSpec, opts: ServerOptions): ServerHandle {
    const argv = resolveCommand(spec);
    const redactor = opts.redactor ?? new Redactor();
    const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const { env: baseEnv } = filterEnv(process.env);
    const env = { ...baseEnv, ...(opts.env ?? {}) };

    const stdout = new BoundedBuffer(maxOutput);
    const stderr = new BoundedBuffer(maxOutput);

    const child = spawn(argv.file, argv.args, {
      cwd: opts.cwd,
      env,
      detached: supportsGroups,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    if (pid !== undefined) this.active.add(pid);

    let alive = true;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const settle = (info: { code: number | null; signal: NodeJS.Signals | null }): void => {
        if (!alive) return;
        alive = false;
        if (pid !== undefined) this.active.delete(pid);
        exitInfo = info;
        resolve(info);
      };
      child.on('error', () => settle({ code: null, signal: null }));
      child.on('close', (code, signal) => settle({ code, signal }));
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      const red = redactor.redact(d);
      stdout.push(red);
      opts.onOutput?.('stdout', red);
    });
    child.stderr?.on('data', (d: string) => {
      const red = redactor.redact(d);
      stderr.push(red);
      opts.onOutput?.('stderr', red);
    });

    const stop = async (graceMs = DEFAULT_GRACE_MS): Promise<void> => {
      if (!alive) {
        void exitInfo;
        return;
      }
      terminateTree(pid, 'SIGTERM');
      const killTimer = setTimeout(() => terminateTree(pid, 'SIGKILL'), graceMs);
      killTimer.unref?.();
      // Resolve when the child actually exits, OR after a hard cap past the SIGKILL
      // escalation — so stop() can never hang if the 'close' event never fires
      // (zombie / unreapable child). The cap is a safety net, not the happy path.
      await new Promise<void>((resolve) => {
        const cap = setTimeout(resolve, graceMs + 2000);
        cap.unref?.();
        void exited.then(() => {
          clearTimeout(cap);
          resolve();
        });
      });
      clearTimeout(killTimer);
    };

    return {
      pid,
      exited,
      running: () => alive,
      output: () => ({ stdout: stdout.value(), stderr: stderr.value() }),
      stop,
    };
  }

  /** Number of children currently tracked as running. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Terminate every tracked child tree (used on hard stop). */
  killAll(sig: NodeJS.Signals = 'SIGTERM'): void {
    for (const pid of this.active) {
      terminateTree(pid, sig);
    }
  }
}
