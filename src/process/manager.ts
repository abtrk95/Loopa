/**
 * Subprocess manager. Every external command (git, project checks, provider CLIs)
 * runs through here. Guarantees:
 *  - shell-free execution (no injection),
 *  - detached process GROUPS so timeouts/cancellation kill child trees,
 *  - graceful SIGTERM then forced SIGKILL after a grace period,
 *  - bounded output buffers (no unbounded memory growth),
 *  - secret redaction on all captured output,
 *  - filtered environment (no git-poisoning vars).
 */
import { spawn } from 'node:child_process';
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

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT = 2_000_000; // 2 MB per stream

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

    const supportsGroups = process.platform !== 'win32';
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

    const killGroup = (sig: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        if (supportsGroups) process.kill(-pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };

    let killTimer: NodeJS.Timeout | undefined;
    const scheduleForceKill = () => {
      killTimer = setTimeout(() => killGroup('SIGKILL'), graceMs);
      killTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      scheduleForceKill();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const onAbort = () => {
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
      function cleanup() {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      }
    });
  }

  /** Number of children currently tracked as running. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Terminate every tracked child (used on hard stop). */
  killAll(sig: NodeJS.Signals = 'SIGTERM'): void {
    const supportsGroups = process.platform !== 'win32';
    for (const pid of this.active) {
      try {
        if (supportsGroups) process.kill(-pid, sig);
        else process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  }
}
