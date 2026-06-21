/**
 * Provider adapter contract. A provider is a WORKER, never the source of truth:
 * its structured output (summary, blocker, files changed) is advisory only — the
 * orchestrator always re-derives reality from git and the deterministic verifier.
 *
 * New providers are added by implementing this interface and registering them;
 * the orchestration core never imports a concrete provider.
 */
import type { Role } from '../domain/schemas.js';
import type { Redactor } from '../security/redact.js';

/** The single completion marker an agent may print to deliver structured output. */
export const RESULT_MARKER = '__AGENT_LOOP_RESULT__';

export interface ProviderCapabilities {
  /** Roles this provider can serve. */
  roles: Role[];
  structuredOutput: boolean;
  streaming: boolean;
}

export interface HealthStatus {
  ok: boolean;
  detail?: string;
}

export interface ProviderRequest {
  role: Role;
  /** The fully-built, fresh context pack (the prompt). */
  contextPack: string;
  /** Working directory (main worktree or a per-slice worktree). */
  cwd: string;
  model?: string | undefined;
  timeoutMs: number;
  redactor?: Redactor;
  signal?: AbortSignal | undefined;
  onOutput?: ((stream: 'stdout' | 'stderr', chunk: string) => void) | undefined;
  /** Adapter-specific options from config (e.g. extra CLI flags). */
  options?: Record<string, unknown>;
  /** Slice id / attempt, for adapters (e.g. the fake provider) that need them. */
  sliceId?: string | undefined;
  attempt?: number | undefined;
}

/** Advisory structured payload an agent may emit via the result marker. */
export interface StructuredResult {
  summary?: string;
  blocker?: string;
  filesChanged?: string[];
  [key: string]: unknown;
}

export interface ProviderResult {
  /** Process completed cleanly (exit 0, not timed out/cancelled). NOT a claim of
   * correctness — correctness is decided by the verifier over git state. */
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  structured?: StructuredResult | undefined;
  /** Set when the agent explicitly signalled it cannot proceed. */
  blocker?: string | undefined;
  costUsd?: number | undefined;
  tokens?: number | undefined;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ProviderAdapter {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  /** Detected CLI/runtime version, or null if not installed. */
  detectVersion(): Promise<string | null>;
  /** Is the provider runnable (binary present)? */
  health(): Promise<HealthStatus>;
  /** Is the provider authenticated (best-effort; may be 'unknown'). */
  authStatus(): Promise<HealthStatus>;
  execute(req: ProviderRequest): Promise<ProviderResult>;
}

/** Parse the last RESULT_MARKER line from agent stdout, if present. */
export function parseStructuredResult(stdout: string): StructuredResult | undefined {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith(RESULT_MARKER)) {
      const json = line.slice(RESULT_MARKER.length).trim();
      try {
        const parsed = JSON.parse(json) as unknown;
        if (parsed && typeof parsed === 'object') return parsed as StructuredResult;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
