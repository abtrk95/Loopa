/**
 * Single-slice lifecycle. This is where the core principle is enforced: the agent
 * is a worker, and only objective evidence advances the loop.
 *
 *   prepare (clean tree) → execute agent → read REAL diff → deterministic verify
 *     → [optional] semantic review → fixer retries (bounded) → scoped commit
 *
 * Every attempt starts from a clean working tree (fresh context, no carryover).
 * Verification is authoritative: a 'block' stops the slice, a 'fail' triggers a
 * bounded fixer retry, only a 'pass' (plus review, if required) leads to a commit.
 */
import { join } from 'node:path';
import { atomicWrite } from '../util/fs.js';
import type { NewEvent } from '../events/types.js';
import type { Config } from '../config/config.js';
import type { Plan, Slice, Risk } from '../domain/schemas.js';
import type { ProjectPaths } from '../util/paths.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Router } from '../providers/routing.js';
import type { Redactor } from '../security/redact.js';
import type { Logger } from '../util/logger.js';
import type { Clock } from '../util/clock.js';
import type { GitRepo } from '../git/repo.js';
import type { ProcessManager } from '../process/manager.js';
import { assertSliceTransition, type SliceState } from '../domain/states.js';
import { newAttemptId } from '../domain/ids.js';
import { buildContextPack, type DependencyResult, type PreviousFailure } from './context.js';
import { verify, type VerificationResult } from '../verify/verifier.js';
import { runReview } from '../review/reviewer.js';
import { maxAttempts, canRetry, backoffDelayMs, sleep } from './retry.js';

export interface ExecContext {
  runId: string;
  emit: (e: Omit<NewEvent, 'runId'>) => void;
  config: Config;
  plan: Plan;
  paths: ProjectPaths;
  registry: ProviderRegistry;
  router: Router;
  pm: ProcessManager;
  redactor: Redactor;
  logger: Logger;
  clock: Clock;
  signal: AbortSignal;
  dependencyResults: Map<string, DependencyResult>;
  branch: string;
}

export interface SliceOutcome {
  sliceId: string;
  status: 'completed' | 'blocked' | 'failed';
  sha?: string;
  summary?: string;
  reason?: string;
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export async function executeSlice(ctx: ExecContext, slice: Slice, workRepo: GitRepo): Promise<SliceOutcome> {
  const total = maxAttempts(ctx.config.execution.maxRetriesPerSlice);
  let sliceState: SliceState = 'READY';
  let previousFailure: PreviousFailure | undefined;

  const transition = (to: SliceState): void => {
    assertSliceTransition(sliceState, to);
    ctx.emit({ type: 'SLICE_STATE_CHANGED', source: 'orchestrator', sliceId: slice.id, payload: { from: sliceState, to } });
    sliceState = to;
  };

  // The worker provider is chosen once per slice (advances round-robin once);
  // retries use the fixer provider (same-as-worker by default).
  const workerSelection = ctx.router.worker(1);

  for (let attempt = 1; attempt <= total; attempt++) {
    if (ctx.signal.aborted) return { sliceId: slice.id, status: 'failed', reason: 'cancelled' };
    const role: 'worker' | 'fixer' = attempt === 1 ? 'worker' : 'fixer';
    const selection = role === 'fixer' ? ctx.router.fixer(workerSelection) : workerSelection;
    const attemptId = newAttemptId();

    // Clean-tree invariant: discard any leftover work so the diff we verify is
    // exactly this attempt's output.
    await workRepo.rollback();
    transition('PREPARING');
    const headBefore = await workRepo.headSha();

    const adapter = ctx.registry.get(selection.provider);
    ctx.emit({
      type: 'PROVIDER_SELECTED',
      source: 'orchestrator',
      sliceId: slice.id,
      attemptId,
      payload: { role, provider: selection.provider, model: selection.model ?? null },
    });

    const pack = buildContextPack({
      plan: ctx.plan,
      slice,
      attempt,
      role,
      branch: ctx.branch,
      headSha: headBefore,
      cwd: workRepo.dir,
      dependencyResults: [...ctx.dependencyResults.values()],
      ...(previousFailure ? { previousFailure } : {}),
      maxBytes: ctx.config.execution.maxOutputBytes,
      redactor: ctx.redactor,
    });
    atomicWrite(join(ctx.paths.contextDir, `${slice.id}__a${attempt}.md`), pack);

    ctx.emit({ type: 'SLICE_STARTED', source: 'orchestrator', sliceId: slice.id, attemptId, payload: { title: slice.title, attempt } });
    transition('EXECUTING');
    ctx.emit({ type: 'AGENT_PROCESS_STARTED', source: 'process', sliceId: slice.id, attemptId, payload: { command: selection.provider, role } });

    let outputLines = 0;
    const result = await adapter.execute({
      role,
      contextPack: pack,
      cwd: workRepo.dir,
      model: selection.model,
      timeoutMs: ctx.config.execution.agentTimeoutMs,
      redactor: ctx.redactor,
      signal: ctx.signal,
      sliceId: slice.id,
      attempt,
      onOutput: (_stream, chunk) => {
        if (outputLines >= 100) return;
        for (const line of chunk.split('\n')) {
          if (!line.trim() || outputLines >= 100) continue;
          outputLines++;
          // Defense in depth: redact even fake-provider output before it is stored.
          ctx.emit({ type: 'AGENT_PROCESS_OUTPUT', source: 'process', sliceId: slice.id, attemptId, payload: { line: ctx.redactor.redact(line.slice(0, 500)) } });
        }
      },
    });
    ctx.emit({
      type: 'AGENT_PROCESS_EXITED',
      source: 'process',
      sliceId: slice.id,
      attemptId,
      payload: { exitCode: result.exitCode, costUsd: result.costUsd ?? 0, tokens: result.tokens ?? 0, timedOut: result.timedOut },
    });

    // Agent explicitly signalled a blocker.
    if (result.blocker) {
      await workRepo.rollback();
      return blockSlice(ctx, slice, transition, `agent blocker: ${result.blocker}`, [], attempt);
    }
    if (ctx.signal.aborted) {
      await workRepo.rollback();
      return { sliceId: slice.id, status: 'failed', reason: 'cancelled' };
    }
    // Process crash / timeout → retry if budget allows.
    if (!result.ok) {
      const reason = result.timedOut ? 'agent process timed out' : `agent process failed (exit ${result.exitCode})`;
      if (canRetry(attempt, ctx.config.execution.maxRetriesPerSlice)) {
        previousFailure = { reason, details: [result.stderr.slice(0, 400)] };
        await scheduleRetry(ctx, slice, transition, reason, attempt);
        continue;
      }
      await workRepo.rollback();
      return blockSlice(ctx, slice, transition, reason, [result.stderr.slice(0, 400)], attempt);
    }

    const changedFiles = (await workRepo.changedPaths()).filter((p) => !p.startsWith('.agent-loop/'));
    ctx.emit({ type: 'FILE_CHANGED', source: 'git', sliceId: slice.id, attemptId, payload: { files: changedFiles } });

    // --- deterministic verification (authoritative) ---
    transition('VERIFYING');
    ctx.emit({ type: 'VERIFICATION_STARTED', source: 'verifier', sliceId: slice.id, attemptId, payload: {} });
    const v = await runVerification(ctx, slice, workRepo, attemptId);

    if (v.verdict === 'block') {
      ctx.emit({ type: 'VERIFICATION_FAILED', source: 'verifier', sliceId: slice.id, attemptId, payload: { reason: v.reason ?? 'blocked' } });
      await workRepo.rollback();
      return blockSlice(ctx, slice, transition, v.reason ?? 'verification block', findingDetails(v), attempt);
    }
    if (v.verdict === 'fail') {
      ctx.emit({ type: 'VERIFICATION_FAILED', source: 'verifier', sliceId: slice.id, attemptId, payload: { reason: v.reason ?? 'failed' } });
      if (canRetry(attempt, ctx.config.execution.maxRetriesPerSlice)) {
        previousFailure = { reason: v.reason ?? 'verification failed', details: findingDetails(v) };
        await workRepo.rollback();
        await scheduleRetry(ctx, slice, transition, v.reason ?? 'verification failed', attempt);
        continue;
      }
      await workRepo.rollback();
      return blockSlice(ctx, slice, transition, `verification failed after ${total} attempt(s): ${v.reason ?? ''}`, findingDetails(v), attempt);
    }
    ctx.emit({ type: 'VERIFICATION_PASSED', source: 'verifier', sliceId: slice.id, attemptId, payload: { addedLines: v.addedLines, files: v.changedFiles.length } });

    // --- optional semantic review (advisory; never overrides verifier) ---
    const review = await maybeReview(ctx, slice, workRepo, attemptId, transition);
    if (review === 'blocked') {
      await workRepo.rollback();
      return blockSlice(ctx, slice, transition, 'reviewer blocked the change', [], attempt);
    }
    if (review === 'changes_requested') {
      if (canRetry(attempt, ctx.config.execution.maxRetriesPerSlice)) {
        previousFailure = { reason: 'reviewer requested changes', details: [] };
        await workRepo.rollback();
        await scheduleRetry(ctx, slice, transition, 'reviewer requested changes', attempt);
        continue;
      }
      if (reviewRequired(ctx, slice)) {
        await workRepo.rollback();
        return blockSlice(ctx, slice, transition, 'reviewer requested changes; retries exhausted', [], attempt);
      }
      // Review is advisory for this risk level → proceed with a recorded flag.
      ctx.logger.warn(`proceeding past advisory review for ${slice.id}`, { sliceId: slice.id });
    }

    // --- scoped commit (idempotent) ---
    transition('COMMITTING');
    const existing = await workRepo.findSliceCommit(slice.id);
    const commit = existing ?? (await workRepo.scopedCommit(v.changedFiles, `${slice.id} ${slice.title}`, slice.id));
    ctx.emit({
      type: 'COMMIT_CREATED',
      source: 'git',
      sliceId: slice.id,
      attemptId,
      idempotencyKey: `commit:${slice.id}`,
      payload: { sha: commit.sha, message: `${slice.id} ${slice.title}`, files: v.changedFiles },
    });
    const summary = result.structured?.summary ?? `completed ${slice.id}`;
    transition('COMPLETED');
    ctx.emit({ type: 'SLICE_COMPLETED', source: 'orchestrator', sliceId: slice.id, attemptId, payload: { sha: commit.sha, summary } });
    return { sliceId: slice.id, status: 'completed', sha: commit.sha, summary };
  }

  // Unreachable in practice (the loop returns), but typed as a safety net.
  return blockSlice(ctx, slice, transition, 'attempt budget exhausted', [], total);
}

async function runVerification(ctx: ExecContext, slice: Slice, workRepo: GitRepo, attemptId: string): Promise<VerificationResult> {
  return verify({
    repo: workRepo,
    slice,
    plan: ctx.plan,
    config: ctx.config,
    pm: ctx.pm,
    redactor: ctx.redactor,
    checksDir: ctx.paths.checksDir,
    signal: ctx.signal,
    onCheckStart: (c) => ctx.emit({ type: 'CHECK_STARTED', source: 'verifier', sliceId: slice.id, attemptId, payload: { checkId: c.id, command: c.command } }),
    onCheckOutput: (c) => ctx.emit({ type: 'CHECK_OUTPUT', source: 'verifier', sliceId: slice.id, attemptId, payload: { checkId: c.id, summary: c.summary } }),
    onCheckFinish: (c) => ctx.emit({ type: 'CHECK_FINISHED', source: 'verifier', sliceId: slice.id, attemptId, payload: { checkId: c.id, ok: c.ok, durationMs: c.durationMs } }),
  });
}

type ReviewResolution = 'pass' | 'changes_requested' | 'blocked';

async function maybeReview(
  ctx: ExecContext,
  slice: Slice,
  workRepo: GitRepo,
  attemptId: string,
  transition: (to: SliceState) => void,
): Promise<ReviewResolution> {
  const sel = ctx.router.reviewer();
  if (!sel) return 'pass';
  if (ctx.plan.riskPolicy.requireReviewAtOrAbove && RISK_RANK[slice.risk] < RISK_RANK[ctx.plan.riskPolicy.requireReviewAtOrAbove]) {
    return 'pass';
  }
  transition('REVIEWING');
  ctx.emit({ type: 'REVIEW_STARTED', source: 'reviewer', sliceId: slice.id, attemptId, payload: { provider: sel.provider } });
  const diff = await workRepo.diffWithUntracked();
  const outcome = await runReview({
    adapter: ctx.registry.get(sel.provider),
    model: sel.model,
    slice,
    diff,
    cwd: workRepo.dir,
    timeoutMs: ctx.config.execution.agentTimeoutMs,
    redactor: ctx.redactor,
    signal: ctx.signal,
  });
  ctx.emit({
    type: 'REVIEW_FINISHED',
    source: 'reviewer',
    sliceId: slice.id,
    attemptId,
    payload: { verdict: outcome.verdict.verdict, malformed: outcome.malformed, findings: outcome.verdict.findings.length },
  });
  return outcome.verdict.verdict;
}

function reviewRequired(ctx: ExecContext, slice: Slice): boolean {
  const threshold = ctx.plan.riskPolicy.requireReviewAtOrAbove;
  return threshold !== undefined && RISK_RANK[slice.risk] >= RISK_RANK[threshold];
}

async function scheduleRetry(ctx: ExecContext, slice: Slice, transition: (to: SliceState) => void, reason: string, attempt: number): Promise<void> {
  transition('RETRY_PENDING');
  ctx.emit({ type: 'SLICE_RETRY_SCHEDULED', source: 'orchestrator', sliceId: slice.id, payload: { attempt, reason } });
  const delay = backoffDelayMs(attempt, ctx.config.execution.retryBackoffMs, ctx.config.execution.retryJitterMs);
  await sleep(delay, ctx.signal);
  transition('READY');
}

function blockSlice(
  ctx: ExecContext,
  slice: Slice,
  transition: (to: SliceState) => void,
  reason: string,
  details: string[],
  attempt: number,
): SliceOutcome {
  // BLOCKED is reachable from any active state; ensure a valid edge.
  try {
    transition('BLOCKED');
  } catch {
    // already terminal-ish; emit the event regardless for the record
  }
  ctx.emit({ type: 'SLICE_BLOCKED', source: 'orchestrator', sliceId: slice.id, payload: { reason, details } });
  writeBlockerReport(ctx, slice, reason, details, attempt);
  return { sliceId: slice.id, status: 'blocked', reason };
}

function writeBlockerReport(ctx: ExecContext, slice: Slice, reason: string, details: string[], attempt: number): void {
  const md = [
    `# Blocked: ${slice.id} — ${slice.title}`,
    ``,
    `**Reason:** ${reason}`,
    `**Attempts:** ${attempt}`,
    ``,
    `## Acceptance criteria`,
    ...slice.acceptanceCriteria.map((c) => `- ${c}`),
    ``,
    ...(details.length ? ['## Details', ...details.map((d) => `- ${d}`), ''] : []),
    `## What to do`,
    `Inspect \`.agent-loop/artifacts/checks/\` for the failing check output, then either`,
    `fix the blocker manually and run \`agent-loop retry\`, or adjust the plan/scope.`,
    ``,
  ].join('\n');
  atomicWrite(join(ctx.paths.reportsDir, `blocked-${slice.id}.md`), ctx.redactor.redact(md));
}

function findingDetails(v: VerificationResult): string[] {
  return v.findings.filter((f) => f.severity !== 'flag').map((f) => `${f.severity}: ${f.detail}`);
}
