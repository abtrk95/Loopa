/**
 * Semantic reviewer. Runs ONLY after the deterministic verifier has already
 * passed, and sees ONLY the diff + the slice's acceptance criteria (clean-room:
 * never the worker's stdout or reasoning). Its structured verdict can request a
 * fixer pass, but it can never turn a deterministic failure into a pass, and
 * malformed output is treated as an advisory pass — it never blocks on garbage.
 */
import { ReviewVerdictSchema, type ReviewVerdict, type Slice } from '../domain/schemas.js';
import type { ProviderAdapter, ProviderRequest } from '../providers/types.js';
import { RESULT_MARKER } from '../providers/types.js';
import type { Redactor } from '../security/redact.js';

export interface ReviewInput {
  adapter: ProviderAdapter;
  model?: string | undefined;
  slice: Slice;
  diff: string;
  cwd: string;
  timeoutMs: number;
  redactor: Redactor;
  signal?: AbortSignal | undefined;
}

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  malformed: boolean;
  raw: string;
}

export function buildReviewPrompt(slice: Slice, diff: string): string {
  return [
    `<!-- agent-loop:slice ${slice.id} -->`,
    `<!-- agent-loop:role reviewer -->`,
    `You are a code reviewer. Evaluate ONLY the diff below against the acceptance`,
    `criteria. Do not run commands. Reply with a single line beginning with`,
    `${RESULT_MARKER} followed by JSON of the form:`,
    `{"verdict":"pass|changes_requested|blocked","findings":[{"severity":"critical|high|medium|low","file":"...","description":"...","requiredAction":"..."}],"summary":"..."}`,
    ``,
    `## Slice: ${slice.id} — ${slice.title}`,
    `${slice.description}`,
    ``,
    `## Acceptance criteria`,
    ...slice.acceptanceCriteria.map((c) => `- ${c}`),
    ``,
    `## Diff`,
    '```diff',
    diff.slice(0, 60_000),
    '```',
    '',
  ].join('\n');
}

export async function runReview(input: ReviewInput): Promise<ReviewOutcome> {
  const req: ProviderRequest = {
    role: 'reviewer',
    contextPack: buildReviewPrompt(input.slice, input.diff),
    cwd: input.cwd,
    model: input.model,
    timeoutMs: input.timeoutMs,
    redactor: input.redactor,
    signal: input.signal,
    sliceId: input.slice.id,
  };
  const result = await input.adapter.execute(req);
  const verdict = extractVerdict(result.structured, result.stdout);
  if (!verdict) {
    return {
      verdict: { verdict: 'pass', findings: [], summary: 'reviewer output unparseable; treated as advisory pass' },
      malformed: true,
      raw: result.stdout,
    };
  }
  return { verdict, malformed: false, raw: result.stdout };
}

function extractVerdict(structured: unknown, stdout: string): ReviewVerdict | undefined {
  // Prefer the structured marker payload.
  const candidates: unknown[] = [];
  if (structured && typeof structured === 'object') candidates.push(structured);
  const fenced = stdout.match(/```json\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      candidates.push(JSON.parse(fenced[1]));
    } catch {
      // ignore
    }
  }
  for (const c of candidates) {
    const parsed = ReviewVerdictSchema.safeParse(c);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
