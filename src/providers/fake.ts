/**
 * Deterministic fake provider. Makes real, scripted file changes so the entire
 * pipeline (verify → commit → next slice) can be exercised with zero API calls.
 * Powers `demo` and the test suite.
 *
 * It reads a script from `<root>/.agent-loop/fake-provider.json` mapping slice ids
 * to the edits to apply. Attempt-indexed scripts allow modelling "fails first,
 * succeeds on retry" scenarios.
 */
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResult,
  HealthStatus,
  StructuredResult,
} from './types.js';
import { RESULT_MARKER } from './types.js';

const FakeAttemptSchema = z
  .object({
    files: z.record(z.string(), z.string()).optional(),
    delete: z.array(z.string()).optional(),
    blocker: z.string().optional(),
    summary: z.string().optional(),
  })
  .strict();

const FakeSliceSchema = z
  .object({
    files: z.record(z.string(), z.string()).optional(),
    delete: z.array(z.string()).optional(),
    blocker: z.string().optional(),
    summary: z.string().optional(),
    attempts: z.array(FakeAttemptSchema).optional(),
  })
  .strict();

const FakeScriptSchema = z
  .object({
    slices: z.record(z.string(), FakeSliceSchema).default({}),
    /** Scripted reviewer verdicts keyed by slice id (role: reviewer). */
    reviews: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  })
  .strict();

export type FakeScript = z.infer<typeof FakeScriptSchema>;

export class FakeProvider implements ProviderAdapter {
  readonly id = 'fake';

  constructor(private readonly root: string) {}

  capabilities(): ProviderCapabilities {
    return { roles: ['planner', 'worker', 'reviewer', 'fixer', 'judge'], structuredOutput: true, streaming: false };
  }

  async detectVersion(): Promise<string | null> {
    return 'fake-1.0.0';
  }
  async health(): Promise<HealthStatus> {
    return { ok: true, detail: 'deterministic in-process provider' };
  }
  async authStatus(): Promise<HealthStatus> {
    return { ok: true, detail: 'no auth required' };
  }

  private loadScript(): FakeScript {
    const path = join(this.root, '.agent-loop', 'fake-provider.json');
    if (!existsSync(path)) return FakeScriptSchema.parse({});
    return FakeScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }

  async execute(req: ProviderRequest): Promise<ProviderResult> {
    const start = performance.now();
    if (req.signal?.aborted) {
      return this.result(start, { cancelled: true });
    }
    const sliceId = req.sliceId ?? extractMarker(req.contextPack, 'slice');
    const attempt = req.attempt ?? Number(extractMarker(req.contextPack, 'attempt') ?? '1') ?? 1;
    const script = this.loadScript();

    // Reviewer/judge roles: emit a scripted verdict (default: pass) and make no edits.
    if (req.role === 'reviewer' || req.role === 'judge') {
      const scripted = sliceId ? script.reviews[sliceId] : undefined;
      const verdict: StructuredResult = scripted ?? { verdict: 'pass', findings: [], summary: 'fake review: pass' };
      req.onOutput?.('stdout', `${RESULT_MARKER} ${JSON.stringify(verdict)}\n`);
      return this.result(start, { structured: verdict });
    }

    const sliceScript = sliceId ? script.slices[sliceId] : undefined;

    if (!sliceScript) {
      // No script for this slice → no-op (the verifier will treat an empty diff
      // as a real failure, exactly as it would for a real provider that did nothing).
      const structured: StructuredResult = { summary: `no fake script for ${sliceId ?? 'unknown slice'}` };
      req.onOutput?.('stdout', `${RESULT_MARKER} ${JSON.stringify(structured)}\n`);
      return this.result(start, { structured });
    }

    const step =
      sliceScript.attempts && sliceScript.attempts.length > 0
        ? sliceScript.attempts[Math.min(attempt - 1, sliceScript.attempts.length - 1)]!
        : sliceScript;

    if (step.blocker) {
      const structured: StructuredResult = { blocker: step.blocker };
      req.onOutput?.('stdout', `${RESULT_MARKER} ${JSON.stringify(structured)}\n`);
      return this.result(start, { structured, blocker: step.blocker });
    }

    const changed: string[] = [];
    for (const [rel, content] of Object.entries(step.files ?? {})) {
      const abs = join(req.cwd, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      changed.push(rel);
    }
    for (const rel of step.delete ?? []) {
      const abs = join(req.cwd, rel);
      if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
      changed.push(rel);
    }

    const structured: StructuredResult = {
      summary: step.summary ?? `applied ${changed.length} change(s) for ${sliceId}`,
      filesChanged: changed,
    };
    req.onOutput?.('stdout', `${RESULT_MARKER} ${JSON.stringify(structured)}\n`);
    return this.result(start, { structured, tokens: 100, costUsd: 0 });
  }

  private result(
    start: number,
    over: Partial<ProviderResult> & { structured?: StructuredResult },
  ): ProviderResult {
    const stdout = over.structured ? `${RESULT_MARKER} ${JSON.stringify(over.structured)}\n` : '';
    return {
      ok: !over.cancelled && !over.blocker,
      exitCode: over.cancelled ? null : 0,
      stdout,
      stderr: '',
      durationMs: Math.max(1, Math.round(performance.now() - start)),
      truncated: false,
      timedOut: false,
      cancelled: over.cancelled ?? false,
      ...over,
    };
  }
}

function extractMarker(pack: string, key: string): string | undefined {
  const m = pack.match(new RegExp(`agent-loop:${key}\\s+([^\\s]+)\\s*-->`));
  return m?.[1];
}
