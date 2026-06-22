/**
 * Generic command-based provider adapter. Real CLI providers (Claude Code, Codex,
 * OpenCode) are presets over this one class, fully overridable via config
 * (`providers.<id>`). Adding a provider needs no change to the orchestration core.
 *
 * SECURITY: no permission-bypass / sandbox-escape flags are added by default. If a
 * provider needs them to edit files autonomously, the user opts in explicitly via
 * `providers.<id>.args`. This is intentional (see docs/security-model.md).
 */
import { ProcessManager } from '../process/manager.js';
import { ProcessError } from '../domain/errors.js';
import type { Role } from '../domain/schemas.js';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResult,
  HealthStatus,
} from './types.js';
import { parseStructuredResult } from './types.js';

export interface CommandAdapterSpec {
  id: string;
  file: string;
  baseArgs: string[];
  /** How the context pack is delivered to the CLI. */
  packDelivery: 'stdin' | 'arg';
  /** Build model-selection args from a model id. */
  modelArgs?: (model: string) => string[];
  versionArgs: string[];
  roles: Role[];
  /** Extra args appended (typically from config). */
  extraArgs?: string[];
  /** Override the default model when a role doesn't specify one. */
  defaultModel?: string;
}

export class CommandProvider implements ProviderAdapter {
  readonly id: string;
  private versionCache: string | null | undefined;

  constructor(
    private readonly spec: CommandAdapterSpec,
    private readonly pm: ProcessManager = new ProcessManager(),
  ) {
    this.id = spec.id;
  }

  capabilities(): ProviderCapabilities {
    return { roles: this.spec.roles, structuredOutput: true, streaming: true };
  }

  async detectVersion(): Promise<string | null> {
    if (this.versionCache !== undefined) return this.versionCache;
    try {
      const res = await this.pm.run([this.spec.file, ...this.spec.versionArgs], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      this.versionCache = res.ok ? res.stdout.trim().split('\n')[0]! : null;
    } catch (err) {
      if (err instanceof ProcessError) this.versionCache = null;
      else throw err;
    }
    return this.versionCache;
  }

  async health(): Promise<HealthStatus> {
    const v = await this.detectVersion();
    return v ? { ok: true, detail: v } : { ok: false, detail: `${this.spec.file} not found on PATH` };
  }

  async authStatus(): Promise<HealthStatus> {
    // Generic adapters can't reliably verify auth without spending tokens.
    return { ok: true, detail: 'auth not verified (provider-managed)' };
  }

  async execute(req: ProviderRequest): Promise<ProviderResult> {
    const model = req.model ?? this.spec.defaultModel;
    const args = [
      ...this.spec.baseArgs,
      ...(model && this.spec.modelArgs ? this.spec.modelArgs(model) : []),
      ...(this.spec.extraArgs ?? []),
      ...(this.spec.packDelivery === 'arg' ? [req.contextPack] : []),
    ];
    let result;
    try {
      result = await this.pm.run([this.spec.file, ...args], {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        ...(req.redactor ? { redactor: req.redactor } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.onOutput ? { onOutput: req.onOutput } : {}),
        ...(this.spec.packDelivery === 'stdin' ? { input: req.contextPack } : {}),
      });
    } catch (err) {
      // Timeout/spawn failures surface as a non-ok result so the orchestrator can
      // apply its retry policy rather than crashing the run.
      const timedOut = (err as { name?: string }).name === 'TimeoutError';
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: req.timeoutMs,
        truncated: false,
        timedOut,
        cancelled: false,
      };
    }
    const structured = parseStructuredResult(result.stdout);
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(structured ? { structured } : {}),
      ...(structured?.blocker ? { blocker: structured.blocker } : {}),
      durationMs: result.durationMs,
      truncated: result.truncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
    };
  }
}

const ALL_ROLES: Role[] = ['planner', 'worker', 'reviewer', 'fixer', 'judge'];

/** Ids of the built-in real-CLI presets (probed by `doctor`/the interview). */
export const PRESET_PROVIDER_IDS = ['claude', 'codex', 'opencode'] as const;

/** Built-in presets. Commands are deliberately minimal & safe; override via config. */
export function presetSpec(id: string): CommandAdapterSpec | undefined {
  switch (id) {
    case 'claude':
      return {
        id,
        file: 'claude',
        baseArgs: ['-p'],
        packDelivery: 'stdin',
        modelArgs: (m) => ['--model', m],
        versionArgs: ['--version'],
        roles: ALL_ROLES,
      };
    case 'codex':
      return {
        id,
        file: 'codex',
        baseArgs: ['exec'],
        packDelivery: 'arg',
        modelArgs: (m) => ['-m', m],
        versionArgs: ['--version'],
        roles: ALL_ROLES,
      };
    case 'opencode':
      return {
        id,
        file: 'opencode',
        baseArgs: ['run'],
        packDelivery: 'arg',
        modelArgs: (m) => ['-m', m],
        versionArgs: ['--version'],
        roles: ALL_ROLES,
      };
    default:
      return undefined;
  }
}
