/**
 * Optional UI smoke-check adapter for frontend slices.
 *
 * STATUS: EXPERIMENTAL / NOT WIRED. This module is not yet invoked by the verifier
 * or executor. There is NO real browser here — no Playwright/Puppeteer, no
 * navigation, no screenshots, no console-error or accessibility capture. The
 * command-based implementation simply runs a user-configured smoke/e2e command
 * (e.g. `npm run e2e`) and saves its TEXT output as an artifact. When wired in
 * future, results would feed the verifier as an additional advisory check and
 * could never override deterministic failures. See docs/verification.md.
 */
import { join } from 'node:path';
import { atomicWrite } from '../util/fs.js';
import type { ProcessManager } from '../process/manager.js';
import type { Redactor } from '../security/redact.js';
import type { CommandSpec } from '../domain/schemas.js';

export interface BrowserCheckRequest {
  cwd: string;
  /** Where the UI smoke command's text log is written (no screenshots are captured). */
  uiSmokeDir: string;
  sliceId: string;
  pm: ProcessManager;
  redactor: Redactor;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface BrowserCheckResult {
  ok: boolean;
  summary: string;
  artifacts: string[];
}

export interface BrowserVerifier {
  readonly id: string;
  check(req: BrowserCheckRequest): Promise<BrowserCheckResult>;
}

/** Default: does nothing, always passes (no UI verification configured). */
export const noopBrowserVerifier: BrowserVerifier = {
  id: 'noop',
  async check(): Promise<BrowserCheckResult> {
    return { ok: true, summary: 'browser verification not configured', artifacts: [] };
  },
};

/** Runs a configured smoke/e2e command and records its output as an artifact. */
export class CommandBrowserVerifier implements BrowserVerifier {
  readonly id = 'command';
  constructor(private readonly command: CommandSpec) {}

  async check(req: BrowserCheckRequest): Promise<BrowserCheckResult> {
    const res = await req.pm
      .run(this.command, {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        redactor: req.redactor,
        ...(req.signal ? { signal: req.signal } : {}),
      })
      .catch((err: unknown) => ({ ok: false, stdout: '', stderr: (err as Error).message, exitCode: null as number | null, durationMs: 0, command: '' }));
    const log = join(req.uiSmokeDir, `${req.sliceId}__ui-smoke.log`);
    atomicWrite(log, `[stdout]\n${res.stdout}\n[stderr]\n${res.stderr}\n`);
    return {
      ok: res.ok,
      summary: res.ok ? 'browser smoke passed' : `browser smoke failed (exit ${res.exitCode})`,
      artifacts: [log],
    };
  }
}
