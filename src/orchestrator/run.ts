/**
 * Run engine: the explicit run-level state machine and main loop. It selects
 * eligible slices (respecting the dependency DAG), runs them sequentially or in
 * safe parallel via worktrees, integrates verified commits, honors the control
 * plane (pause/resume/stop), performs final global verification, and computes the
 * terminal run state — all from objective evidence.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../util/fs.js';
import type { Session, RunMeta } from './session.js';
import { saveRunMeta } from './session.js';
import type { NewEvent } from '../events/types.js';
import { project, type RunSnapshot } from '../events/projection.js';
import { assertRunTransition, isTerminalRunState, type RunState } from '../domain/states.js';
import type { Plan, Slice } from '../domain/schemas.js';
import { GitError } from '../domain/errors.js';
import { Router } from '../providers/routing.js';
import { WorktreePool } from '../git/worktree.js';
import { ControlPlane } from './control.js';
import { eligibleSlices, topoOrder, canRunInParallel } from '../planner/graph.js';
import { executeSlice, type ExecContext, type SliceOutcome } from './executor.js';
import { verify } from '../verify/verifier.js';
import type { DependencyResult } from './context.js';
import { generateReport } from './report.js';

export interface RunResult {
  runId: string;
  finalState: RunState;
  snapshot: RunSnapshot;
  reportPath: string;
}

export class RunEngine {
  private readonly runId: string;
  private readonly router: Router;
  private readonly control: ControlPlane;
  private readonly abort = new AbortController();
  private runState: RunState = 'PLAN_READY';
  private branch: string;
  private baselineSha = '';
  private readonly completed = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly dependencyResults = new Map<string, DependencyResult>();
  private controlPoller: NodeJS.Timeout | undefined;

  constructor(
    private readonly session: Session,
    private readonly plan: Plan,
    private readonly meta: RunMeta,
    opts: { signal?: AbortSignal } = {},
  ) {
    this.runId = meta.runId;
    this.branch = meta.branch ?? '';
    this.baselineSha = meta.baselineSha ?? '';
    this.router = new Router(session.config, (provider, role) =>
      session.registry.has(provider) && session.registry.get(provider).capabilities().roles.includes(role),
    );
    this.control = new ControlPlane(session.paths.controlDir);
    if (opts.signal) {
      if (opts.signal.aborted) this.abort.abort();
      else opts.signal.addEventListener('abort', () => this.abort.abort(), { once: true });
    }
  }

  private emit(e: Omit<NewEvent, 'runId'>): void {
    this.session.store.append({ runId: this.runId, ...e });
  }

  private setRunState(to: RunState, semanticEvent?: { type: NewEvent['type']; payload?: Record<string, unknown> }): void {
    assertRunTransition(this.runState, to);
    if (semanticEvent) {
      this.emit({ type: semanticEvent.type, source: 'orchestrator', payload: semanticEvent.payload ?? {} });
    } else {
      this.emit({ type: 'RUN_STATE_CHANGED', source: 'orchestrator', payload: { from: this.runState, to } });
    }
    this.runState = to;
  }

  async start(): Promise<RunResult> {
    this.seedFromHistory();
    await this.preflight();
    this.startControlPoller();
    try {
      this.setRunState('RUNNING', { type: 'RUN_STARTED', payload: { branch: this.branch } });
      await this.mainLoop();
      return await this.finish();
    } finally {
      this.stopControlPoller();
    }
  }

  async resume(): Promise<RunResult> {
    this.seedFromHistory();
    if (!this.branch) throw new GitError('cannot resume: run branch unknown');
    await this.ensureOnBranch();
    if (this.runState === 'COMPLETED') return this.result('COMPLETED'); // already done — no-op
    await this.reconcile();
    this.clearBlockedForRetry();
    this.startControlPoller();
    try {
      this.reenterRunning();
      await this.mainLoop();
      return await this.finish();
    } finally {
      this.stopControlPoller();
    }
  }

  /** Re-enter the RUNNING state on resume/retry from any non-completed state. */
  private reenterRunning(): void {
    if (this.runState === 'RUNNING') return;
    if (isTerminalRunState(this.runState)) {
      // retry after FAILED/CANCELLED: re-open the run (record it; the durable log
      // already holds the terminal event, so we bypass the terminal-state assert).
      this.emit({ type: 'RUN_RESUMED', source: 'orchestrator', payload: { branch: this.branch } });
      this.runState = 'RUNNING';
      return;
    }
    const eventType = this.runState === 'CREATED' || this.runState === 'PLAN_READY' ? 'RUN_STARTED' : 'RUN_RESUMED';
    this.setRunState('RUNNING', { type: eventType, payload: { branch: this.branch } });
  }

  /** Rebuild in-memory progress from the durable event log. */
  private seedFromHistory(): void {
    const snap = project(this.session.store.read(this.runId));
    this.runState = snap.runState;
    for (const [id, view] of Object.entries(snap.slices)) {
      if (view.state === 'COMPLETED') {
        this.completed.add(id);
        this.dependencyResults.set(id, { id, title: view.title, summary: view.lastCommit ? `committed ${view.lastCommit}` : 'completed' });
      } else if (view.state === 'BLOCKED') {
        this.blocked.add(id);
      } else if (view.state === 'FAILED') {
        this.failed.add(id);
      }
    }
  }

  private async preflight(): Promise<void> {
    const git = this.session.git;
    if (!(await git.isRepo())) {
      throw new GitError(`not a git repository: ${this.session.root}`);
    }
    // Note: we never auto-edit the user's .gitignore during a run (that would dirty
    // the tree). `agent-loop init` adds the ignore entry; here we just filter our
    // own metadata dir out of the cleanliness check.
    const dirty = (await git.status()).filter((s) => !s.path.startsWith('.agent-loop/') && s.path !== '.agent-loop');
    if (dirty.length > 0 && this.session.config.git.requireCleanTree && !this.session.config.git.allowDirty) {
      throw new GitError(
        `working tree has ${dirty.length} uncommitted change(s). Commit/stash them, or set git.allowDirty: true to override.`,
        { details: { files: dirty.map((d) => d.path).slice(0, 20) } },
      );
    }
    if (!this.branch) {
      this.branch = deriveBranchName(this.session.config.git.branchPrefix, this.plan.goal);
    }
    const current = await git.currentBranch();
    if (current !== this.branch) {
      if (await git.branchExists(this.branch)) await git.checkout(this.branch);
      else await git.createBranch(this.branch);
    }
    this.baselineSha = await git.headSha();
    saveRunMeta(this.session.paths, { ...this.meta, branch: this.branch, baselineSha: this.baselineSha });
  }

  private async ensureOnBranch(): Promise<void> {
    const git = this.session.git;
    if (!(await git.isRepo())) throw new GitError(`not a git repository: ${this.session.root}`);
    const current = await git.currentBranch();
    if (current !== this.branch) {
      if (await git.branchExists(this.branch)) await git.checkout(this.branch);
      else throw new GitError(`run branch ${this.branch} no longer exists`);
    }
  }

  /** On resume, recover slices whose commit landed before the event was written. */
  private async reconcile(): Promise<void> {
    for (const slice of this.plan.slices) {
      if (this.completed.has(slice.id) || this.blocked.has(slice.id) || this.failed.has(slice.id)) continue;
      const commit = await this.session.git.findSliceCommit(slice.id);
      if (commit) {
        this.emit({ type: 'COMMIT_CREATED', source: 'git', sliceId: slice.id, idempotencyKey: `commit:${slice.id}`, payload: { sha: commit.sha, message: commit.message } });
        this.emit({ type: 'SLICE_STATE_CHANGED', source: 'orchestrator', sliceId: slice.id, payload: { from: 'PENDING', to: 'COMPLETED' } });
        this.emit({ type: 'SLICE_COMPLETED', source: 'orchestrator', sliceId: slice.id, payload: { sha: commit.sha, summary: 'recovered on resume' } });
        this.completed.add(slice.id);
        this.dependencyResults.set(slice.id, { id: slice.id, title: slice.title, summary: `committed ${commit.sha}` });
      }
    }
    // Discard any uncommitted leftovers from an interrupted attempt.
    await this.session.git.rollback();
  }

  /** On resume/retry, blocked slices become eligible again for another attempt. */
  private clearBlockedForRetry(): void {
    for (const id of [...this.blocked]) {
      this.emit({ type: 'SLICE_STATE_CHANGED', source: 'orchestrator', sliceId: id, payload: { from: 'BLOCKED', to: 'READY' } });
      this.blocked.delete(id);
    }
  }

  private async mainLoop(): Promise<void> {
    for (;;) {
      const control = await this.handleControl();
      if (control === 'stopped') {
        this.cancel();
        return;
      }
      const eligible = topoOrder(eligibleSlices(this.plan.slices, this.completed, this.busy()));
      if (eligible.length === 0) break;
      const batch = this.selectBatch(eligible);
      for (const s of batch) {
        this.emit({ type: 'SLICE_READY', source: 'orchestrator', sliceId: s.id, payload: { title: s.title } });
        this.emit({ type: 'SLICE_STATE_CHANGED', source: 'orchestrator', sliceId: s.id, payload: { from: 'PENDING', to: 'READY' } });
      }
      const outcomes = batch.length === 1 ? [await this.runSingle(batch[0]!)] : await this.runParallel(batch);
      for (const outcome of outcomes) this.applyOutcome(outcome);
      if (this.abort.signal.aborted) {
        this.cancel();
        return;
      }
    }
    this.cascadeBlockUnreachable();
  }

  private busy(): Set<string> {
    return new Set([...this.blocked, ...this.failed]);
  }

  private selectBatch(eligible: Slice[]): Slice[] {
    const concurrency = this.session.config.execution.concurrency;
    if (concurrency <= 1 || eligible.length === 0) return eligible.slice(0, 1);
    const first = eligible[0]!;
    if (!first.parallelSafe) return [first];
    const batch: Slice[] = [first];
    for (const candidate of eligible.slice(1)) {
      if (batch.length >= concurrency) break;
      if (candidate.parallelSafe && batch.every((b) => canRunInParallel(b, candidate))) {
        batch.push(candidate);
      }
    }
    return batch;
  }

  private execContext(branch: string): Omit<ExecContext, 'runId'> & { runId: string } {
    return {
      runId: this.runId,
      emit: (e) => this.emit(e),
      config: this.session.config,
      plan: this.plan,
      paths: this.session.paths,
      registry: this.session.registry,
      router: this.router,
      pm: this.session.pm,
      redactor: this.session.redactor,
      logger: this.session.logger,
      clock: this.session.clock,
      signal: this.abort.signal,
      dependencyResults: this.dependencyResults,
      branch,
    };
  }

  private async runSingle(slice: Slice): Promise<SliceOutcome> {
    return executeSlice(this.execContext(this.branch), slice, this.session.git);
  }

  private async runParallel(batch: Slice[]): Promise<SliceOutcome[]> {
    const pool = new WorktreePool(this.session.git, this.session.paths.worktreesDir, this.branch);
    const baseRef = await this.session.git.headSha();
    try {
      const handles = await Promise.all(batch.map((s) => pool.acquire(s.id, baseRef)));
      const outcomes = await Promise.all(
        batch.map((slice, i) => executeSlice(this.execContext(this.branch), slice, handles[i]!.repo)),
      );
      // Integrate verified commits sequentially onto the run branch.
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i]!;
        if (outcome.status === 'completed' && outcome.sha) {
          const integrated = await this.session.git.integrateCommit(outcome.sha);
          if (integrated === 'conflict') {
            outcome.status = 'failed';
            outcome.reason = 'merge conflict during parallel integration';
            this.emit({ type: 'SLICE_BLOCKED', source: 'orchestrator', sliceId: outcome.sliceId, payload: { reason: outcome.reason } });
          }
        }
      }
      return outcomes;
    } finally {
      await pool.releaseAll();
    }
  }

  private applyOutcome(outcome: SliceOutcome): void {
    if (outcome.status === 'completed') {
      this.completed.add(outcome.sliceId);
      const slice = this.plan.slices.find((s) => s.id === outcome.sliceId);
      this.dependencyResults.set(outcome.sliceId, {
        id: outcome.sliceId,
        title: slice?.title ?? outcome.sliceId,
        summary: outcome.summary ?? 'completed',
      });
    } else if (outcome.status === 'blocked') {
      this.blocked.add(outcome.sliceId);
    } else {
      this.failed.add(outcome.sliceId);
    }
  }

  /** Slices that can never run because a dependency is blocked/failed. */
  private cascadeBlockUnreachable(): void {
    for (const slice of this.plan.slices) {
      if (this.completed.has(slice.id) || this.blocked.has(slice.id) || this.failed.has(slice.id)) continue;
      const reason = `unreachable: dependency blocked/failed (${slice.dependencies.join(', ')})`;
      this.emit({ type: 'SLICE_BLOCKED', source: 'orchestrator', sliceId: slice.id, payload: { reason } });
      this.emit({ type: 'SLICE_STATE_CHANGED', source: 'orchestrator', sliceId: slice.id, payload: { from: 'PENDING', to: 'BLOCKED' } });
      this.blocked.add(slice.id);
    }
  }

  private async finish(): Promise<RunResult> {
    // A stop request may have already driven us to a terminal state in mainLoop.
    if (isTerminalRunState(this.runState)) return this.result(this.runState);
    if (this.abort.signal.aborted) return this.terminal('CANCELLED', { type: 'RUN_CANCELLED' });
    const allDone = this.plan.slices.every((s) => this.completed.has(s.id));
    if (allDone) {
      const ok = await this.finalVerify();
      if (ok) return this.terminal('COMPLETED', { type: 'RUN_COMPLETED' });
      return this.terminal('FAILED', { type: 'RUN_FAILED', payload: { reason: 'final verification failed' } });
    }
    if (this.failed.size > 0) {
      return this.terminal('FAILED', { type: 'RUN_FAILED', payload: { reason: `${this.failed.size} slice(s) failed` } });
    }
    // Some slices blocked → run is blocked, resumable after human action.
    this.setRunState('BLOCKED');
    return this.result('BLOCKED');
  }

  private async finalVerify(): Promise<boolean> {
    this.setRunState('FINAL_VERIFYING', { type: 'FINAL_VERIFICATION_STARTED' });
    const finalSlice: Slice = {
      id: 'FINAL',
      title: 'final verification',
      description: 'global verification of the integrated result',
      acceptanceCriteria: ['all global checks pass'],
      dependencies: [],
      allowedPaths: ['**'],
      forbiddenPaths: [],
      requiredChecks: this.plan.verification.map((c) => c.id),
      risk: 'low',
      preferredRole: 'worker',
      parallelSafe: false,
    };
    const result = await verify({
      repo: this.session.git,
      slice: finalSlice,
      plan: this.plan,
      config: this.session.config,
      pm: this.session.pm,
      redactor: this.session.redactor,
      checksDir: this.session.paths.checksDir,
      signal: this.abort.signal,
      isFinal: true,
      onCheckStart: (c) => this.emit({ type: 'CHECK_STARTED', source: 'verifier', sliceId: 'FINAL', payload: { checkId: c.id, command: c.command } }),
      onCheckFinish: (c) => this.emit({ type: 'CHECK_FINISHED', source: 'verifier', sliceId: 'FINAL', payload: { checkId: c.id, ok: c.ok, durationMs: c.durationMs } }),
    });
    this.emit({ type: 'FINAL_VERIFICATION_FINISHED', source: 'verifier', payload: { verdict: result.verdict, checks: result.checks.length } });
    return result.verdict === 'pass';
  }

  private terminal(state: RunState, semanticEvent: { type: NewEvent['type']; payload?: Record<string, unknown> }): RunResult {
    this.setRunState(state, semanticEvent);
    return this.result(state);
  }

  private result(state: RunState): RunResult {
    const snapshot = project(this.session.store.read(this.runId));
    const reportPath = generateReport(this.session, this.plan, snapshot);
    return { runId: this.runId, finalState: state, snapshot, reportPath };
  }

  private cancel(): void {
    this.session.pm.killAll();
    if (this.runState === 'RUNNING' || this.runState === 'PAUSED' || this.runState === 'FINAL_VERIFYING' || this.runState === 'BLOCKED') {
      this.setRunState('CANCELLED', { type: 'RUN_CANCELLED' });
    }
  }

  // --- control plane ---------------------------------------------------------

  private async handleControl(): Promise<'continue' | 'stopped'> {
    let desired = this.control.getDesired();
    if (desired === 'stopped') return 'stopped';
    if (desired === 'paused') {
      this.setRunState('PAUSED', { type: 'RUN_PAUSED' });
      while (desired === 'paused') {
        const { sleep } = await import('./retry.js');
        const ok = await sleep(300, this.abort.signal);
        if (!ok) return 'stopped';
        desired = this.control.getDesired();
      }
      if (desired === 'stopped') return 'stopped';
      this.setRunState('RUNNING', { type: 'RUN_RESUMED' });
    }
    return 'continue';
  }

  private startControlPoller(): void {
    this.controlPoller = setInterval(() => {
      if (this.control.getDesired() === 'stopped' && !this.abort.signal.aborted) {
        this.emit({ type: 'RUN_STOP_REQUESTED', source: 'control', payload: {} });
        this.abort.abort();
      }
    }, 300);
    this.controlPoller.unref?.();
  }

  private stopControlPoller(): void {
    if (this.controlPoller) clearInterval(this.controlPoller);
  }
}

export function deriveBranchName(prefix: string, goal: string): string {
  const slug =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'run';
  return `${prefix}${slug}`;
}

export function ensureRepoIgnoresAgentDir(root: string): void {
  const gi = join(root, '.gitignore');
  const line = '.agent-loop/';
  let content = '';
  if (existsSync(gi)) content = readFileSync(gi, 'utf8');
  if (content.split('\n').some((l) => l.trim() === line || l.trim() === '.agent-loop')) return;
  const next = content.length === 0 ? `${line}\n` : content.endsWith('\n') ? `${content}${line}\n` : `${content}\n${line}\n`;
  atomicWrite(gi, next);
}
