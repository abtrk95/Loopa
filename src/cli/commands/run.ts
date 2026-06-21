/**
 * `agent-loop run` / `agent-loop retry` — execute (or resume) the plan. Supports
 * fully autonomous (`--auto`) and human-approved execution, plus an integrated live
 * dashboard (`--watch`).
 */
import { createInterface } from 'node:readline';
import { openSession, loadPlan, loadRunMeta, type Session, type RunMeta } from '../../orchestrator/session.js';
import { createPlan } from '../../orchestrator/planning.js';
import { RunEngine } from '../../orchestrator/run.js';
import { IntakeError, PlanValidationError } from '../../domain/errors.js';
import type { Plan } from '../../domain/schemas.js';
import type { RunState } from '../../domain/states.js';
import { runWatch } from '../../watch/dashboard.js';
import { resolveInput } from '../intake-input.js';
import { printPlanSummary } from './plan.js';
import { cliConfigOverrides, flagBool, resolveRoot, type ParsedArgs } from '../args.js';

export function exitCodeForState(state: RunState): number {
  switch (state) {
    case 'COMPLETED':
      return 0;
    case 'FAILED':
      return 1;
    case 'BLOCKED':
      return 2;
    case 'CANCELLED':
      return 3;
    default:
      return 0;
  }
}

export async function cmdRun(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const session = openSession({ root, cliOverrides: cliConfigOverrides(args), logStream: undefined });
  try {
    const input = await resolveInput(args, root);
    let plan: Plan | undefined;
    if (input) {
      plan = createPlan(session, { input, auto: flagBool(args, 'auto') || session.config.auto }).plan;
    } else {
      plan = loadPlan(session.paths);
      if (!plan) {
        throw new IntakeError('no plan found. Provide --idea/--prd/--issue/--stdin, or run `agent-loop plan` first.');
      }
    }
    const meta = loadRunMeta(session.paths);
    if (!meta) throw new PlanValidationError('no run metadata; re-run `agent-loop plan`.', []);

    const auto = flagBool(args, 'auto') || session.config.auto || flagBool(args, 'yes');
    if (!auto) {
      const approved = await approvePlan(plan);
      if (!approved) {
        process.stdout.write('Plan ready (not executed). Re-run with --auto to execute.\n');
        return 0;
      }
    }
    return await executeRun(session, plan, meta, args, false);
  } finally {
    session.close();
  }
}

export async function cmdRetry(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const session = openSession({ root, cliOverrides: cliConfigOverrides(args) });
  try {
    const plan = loadPlan(session.paths);
    const meta = loadRunMeta(session.paths);
    if (!plan || !meta) throw new IntakeError('nothing to retry: no plan/run found. Run `agent-loop plan` first.');
    return await executeRun(session, plan, meta, args, true);
  } finally {
    session.close();
  }
}

async function executeRun(session: Session, plan: Plan, meta: RunMeta, args: ParsedArgs, resume: boolean): Promise<number> {
  // Graceful cancellation: SIGINT/SIGTERM abort the engine, which kills the active
  // child process groups and drives the run to a CANCELLED terminal state.
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = (): void => {
    interrupts++;
    if (interrupts === 1) {
      process.stderr.write('\nstopping run (signal received) — finishing safely…\n');
      controller.abort();
    } else {
      // A second signal: hard exit (children already receive SIGTERM via abort).
      process.exit(130);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await executeRunInner(session, plan, meta, args, resume, controller);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function executeRunInner(session: Session, plan: Plan, meta: RunMeta, args: ParsedArgs, resume: boolean, controller: AbortController): Promise<number> {
  const engine = new RunEngine(session, plan, meta, { signal: controller.signal });
  const watch = flagBool(args, 'watch');

  if (watch) {
    const enginePromise = (resume ? engine.resume() : engine.start()).catch((e: unknown) => {
      process.stderr.write(`run error: ${(e as Error).message}\n`);
      return undefined;
    });
    await runWatch({
      root: session.root,
      runId: meta.runId,
      color: !flagBool(args, 'no-color'),
      exitWhenFinished: true,
    });
    const result = await enginePromise;
    if (!result) return 1;
    process.stdout.write(`\nRun ${result.finalState}. Report: ${result.reportPath}\n`);
    return exitCodeForState(result.finalState);
  }

  const stop = startProgressPrinter(session, meta.runId);
  try {
    const result = resume ? await engine.resume() : await engine.start();
    stop();
    printSummary(result.finalState, result.reportPath);
    return exitCodeForState(result.finalState);
  } catch (err) {
    stop();
    throw err;
  }
}

function printSummary(state: RunState, reportPath: string): void {
  process.stdout.write(`\n── run ${state} ──\nReport: ${reportPath}\n`);
}

/** Stream notable events to stderr while a non-watch run executes. */
function startProgressPrinter(session: Session, runId: string): () => void {
  let lastSeq = 0;
  const notable = new Set([
    'SLICE_READY',
    'PROVIDER_SELECTED',
    'VERIFICATION_PASSED',
    'VERIFICATION_FAILED',
    'COMMIT_CREATED',
    'SLICE_COMPLETED',
    'SLICE_RETRY_SCHEDULED',
    'SLICE_BLOCKED',
    'FINAL_VERIFICATION_STARTED',
    'RUN_COMPLETED',
    'RUN_FAILED',
  ]);
  const timer = setInterval(() => {
    const events = session.store.readSince(lastSeq, runId);
    for (const ev of events) {
      lastSeq = Math.max(lastSeq, ev.seq);
      if (!notable.has(ev.type)) continue;
      const sid = ev.sliceId ? `${ev.sliceId} ` : '';
      const extra = ev.type === 'COMMIT_CREATED' ? String(ev.payload['sha'] ?? '').slice(0, 8) : ev.type === 'SLICE_BLOCKED' ? String(ev.payload['reason'] ?? '') : '';
      process.stderr.write(`  ${ev.type} ${sid}${extra}\n`);
    }
  }, 400);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function approvePlan(plan: Plan): Promise<boolean> {
  printPlanSummary(plan, { ok: true, issues: [], warnings: [] });
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question('\nRun this plan? [y/N] ', resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
