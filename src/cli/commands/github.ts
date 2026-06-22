/**
 * `agent-loop github <subcommand>` — GitHub triage + Kanban orchestration.
 *
 *   github triage    --repo o/n [--dry-run|--apply] [--issue N] [--comment] [--all]
 *   github import    --repo o/n --issue N [--interview [mode]]
 *   github run-issue --repo o/n --issue N [--auto] [--apply] [--pr] [--project]
 *   github watch     --repo o/n [--once] [--dry-run|--apply] [--interval N] [--max-iterations N]
 *   github project   sync --repo o/n --issue N [--status S] [--dry-run|--apply]
 *   github pr        create|update --repo o/n [--issue N] [--push] [--no-draft]
 *
 * The local deterministic loop stays authoritative. GitHub automation NEVER
 * auto-merges, auto-deploys, closes issues, or bypasses the verifier. Triage,
 * watch, and project sync default to DRY-RUN; every external write is logged.
 */
import { openSession, loadRunMeta, type Session } from '../../orchestrator/session.js';
import { createPlan } from '../../orchestrator/planning.js';
import { RunEngine } from '../../orchestrator/run.js';
import { acquireRunLock, releaseRunLock } from '../../process/pidfile.js';
import { project as projectEvents } from '../../events/projection.js';
import { SqliteEventStore } from '../../events/store.js';
import { GhClient, type GhWrite } from '../../github/client.js';
import { triageRepo } from '../../github/triage.js';
import {
  statusLabelForRunState,
  projectStatusForRunState,
  PROJECT_STATUSES,
  type ProjectStatus,
} from '../../github/labels.js';
import { detectProject, syncIssueStatus } from '../../github/project.js';
import { watchOnce, watchLoop, watchPaths } from '../../github/watch.js';
import { createPullRequest, updatePullRequest } from '../../github/pr.js';
import { gatherInterview, interviewRequested, interviewModeFromArgs } from './interview.js';
import { exitCodeForState } from './run.js';
import { ControlError, IntakeError } from '../../domain/errors.js';
import type { GithubConfig } from '../../config/config.js';
import type { RawInput } from '../../intake/normalize.js';
import type { RunState } from '../../domain/states.js';
import { cliConfigOverrides, flagBool, flagNum, flagStr, resolveRoot, type ParsedArgs } from '../args.js';

const USAGE = `Usage: agent-loop github <command>

  triage    --repo o/n [--dry-run|--apply] [--issue N] [--comment] [--all] [--mode quick|standard|strict]
  import    --repo o/n --issue N [--interview [mode]] [--auto]
  run-issue --repo o/n --issue N [--auto] [--apply] [--pr] [--project] [--interview]
  watch     --repo o/n [--once] [--dry-run|--apply] [--interval N] [--max-iterations N] [--comment] [--project]
  project   sync --repo o/n --issue N [--status <column>] [--dry-run|--apply]
  pr        create|update --repo o/n [--issue N] [--push] [--no-draft] [--base B] [--remote R] [--dry-run]

Triage / watch / project sync default to DRY-RUN. Nothing auto-merges or deploys.
`;

export async function cmdGithub(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];
  switch (sub) {
    case 'triage':
      return withSession(args, githubTriage);
    case 'import':
      return withSession(args, githubImport);
    case 'run-issue':
      return withSession(args, githubRunIssue);
    case 'watch':
      return withSession(args, githubWatch);
    case 'project':
      return withSession(args, githubProject);
    case 'pr':
      return withSession(args, githubPr);
    default:
      process.stdout.write(USAGE);
      return sub ? 1 : 0;
  }
}

async function withSession(args: ParsedArgs, fn: (session: Session, args: ParsedArgs) => Promise<number>): Promise<number> {
  const root = resolveRoot(args);
  const session = openSession({ root, cliOverrides: cliConfigOverrides(args) });
  try {
    return await fn(session, args);
  } finally {
    session.close();
  }
}

// --- shared helpers ----------------------------------------------------------

function resolveRepo(args: ParsedArgs, gh: GithubConfig): string {
  const repo = flagStr(args, 'repo') ?? gh.repo;
  if (!repo) throw new IntakeError('missing --repo owner/name (or set github.repo in .agent-loop/config.yml)');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new IntakeError(`--repo must be owner/name, got '${repo}'`);
  return repo;
}

/** Dry-run is the default for triage/watch/project. `--apply` opts into writes;
 * an explicit `--dry-run` always wins. */
function isDryRun(args: ParsedArgs): boolean {
  if (flagBool(args, 'dry-run')) return true;
  return !flagBool(args, 'apply');
}

function makeClient(session: Session, dryRun: boolean): GhClient {
  return new GhClient(session.root, {
    dryRun,
    pm: session.pm,
    onWrite: (w: GhWrite) => process.stderr.write(`  [gh ${w.dryRun ? 'DRY-RUN' : 'apply'}] ${w.action}: ${w.detail}\n`),
  });
}

function requireIssue(args: ParsedArgs): number {
  const n = flagNum(args, 'issue');
  if (n === undefined || !Number.isInteger(n) || n <= 0) {
    throw new IntakeError('missing/invalid --issue <number>');
  }
  return n;
}

// --- triage ------------------------------------------------------------------

async function githubTriage(session: Session, args: ParsedArgs): Promise<number> {
  const cfg = session.config.github;
  const repo = resolveRepo(args, cfg);
  const dryRun = isDryRun(args);
  const client = makeClient(session, dryRun);
  const mode = interviewModeFromArgs(args, undefined, cfg.triage.interviewMode);
  const report = await triageRepo(client, cfg, {
    repo,
    mode,
    comment: flagBool(args, 'comment') || cfg.triage.commentClarifications,
    onlyTriggered: !flagBool(args, 'all'),
    ...(flagNum(args, 'issue') !== undefined ? { issue: requireIssue(args) } : {}),
  });

  if (flagBool(args, 'json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }
  const out = process.stdout;
  out.write(`Triage ${repo} (${dryRun ? 'DRY-RUN — no writes' : 'APPLY'}) — ${report.considered} considered, ${report.skipped} skipped\n\n`);
  for (const r of report.results) {
    out.write(`  #${r.number} [${r.status}] (${r.risk}) ${r.title}\n`);
    for (const reason of r.reasons) out.write(`        ${reason}\n`);
    if (r.labelsAdded.length) out.write(`        ${dryRun ? 'would add' : 'added'}: ${r.labelsAdded.join(', ')}\n`);
    if (r.clarifications.length && (r.status === 'needs-info' || r.status === 'too-risky')) {
      out.write(`        clarify: ${r.clarifications.length} question(s)${r.commented ? ' (commented)' : ''}\n`);
    }
  }
  out.write(`\n${dryRun ? 'Re-run with --apply to write labels/comments.' : 'Labels/comments applied. No work was started.'}\n`);
  return 0;
}

// --- import (issue → plan, no run) ------------------------------------------

async function planFromIssue(session: Session, args: ParsedArgs, repo: string, issueNum: number, auto: boolean) {
  const reader = makeClient(session, true); // read-only for import
  const issue = await reader.viewIssue(repo, issueNum);
  const input: RawInput = { kind: 'issue', text: `${issue.title}\n\n${issue.body}`, ref: `#${issueNum}` };
  if (interviewRequested(args)) {
    const { outcome, input: effective } = await gatherInterview(session, args, interviewModeFromArgs(args), input);
    return createPlan(session, { input: effective, auto, interview: outcome });
  }
  return createPlan(session, { input, auto });
}

async function githubImport(session: Session, args: ParsedArgs): Promise<number> {
  const repo = resolveRepo(args, session.config.github);
  const issueNum = requireIssue(args);
  const auto = flagBool(args, 'auto') || session.config.auto;
  const result = await planFromIssue(session, args, repo, issueNum, auto);
  process.stdout.write(`Imported ${repo}#${issueNum} → plan ${result.plan.planId} (${result.plan.slices.length} slice(s)).\n`);
  process.stdout.write(`Plan: ${session.paths.planJson}\nRun it with: agent-loop run --auto  (or: agent-loop github run-issue --repo ${repo} --issue ${issueNum} --auto)\n`);
  return 0;
}

// --- run-issue (import → plan → run → update labels/project/PR) --------------

async function githubRunIssue(session: Session, args: ParsedArgs): Promise<number> {
  const cfg = session.config.github;
  const repo = resolveRepo(args, cfg);
  const issueNum = requireIssue(args);
  const auto = flagBool(args, 'auto') || session.config.auto;
  const dryRun = isDryRun(args);
  const syncProject = flagBool(args, 'project') || cfg.project.enabled;
  const client = makeClient(session, dryRun);
  const warnings: string[] = [];

  // Plan from the issue (optionally interviewing for missing detail).
  const planned = await planFromIssue(session, args, repo, issueNum, auto);
  const meta = loadRunMeta(session.paths);
  if (!meta) throw new ControlError('no run metadata after planning; aborting.');

  // Acquire the single-writer run lock BEFORE any GitHub writes so a concurrent run
  // cannot race the label/board updates for this issue.
  const lock = acquireRunLock(session.paths.runLock, meta.runId, Date.now());
  if (!lock.ok) throw new ControlError(`another agent-loop run is active (pid ${lock.holder.pid}).`);
  let finalState: RunState;
  let reportPath: string;
  try {
    // Track issue labels so status updates are precise (no removing absent labels).
    const issue = await client.viewIssue(repo, issueNum);
    const labelSet = new Set(issue.labels);
    await setRunStatus(client, cfg, repo, issueNum, labelSet, 'RUNNING', syncProject, warnings);

    const engine = new RunEngine(session, planned.plan, meta);
    const result = await engine.start();
    finalState = result.finalState;
    reportPath = result.reportPath;

    await setRunStatus(client, cfg, repo, issueNum, labelSet, finalState, syncProject, warnings);

    // Optional draft PR (explicit; never merges/deploys).
    if (flagBool(args, 'pr')) {
      const snap = projectEvents(session.store.read(meta.runId));
      if (dryRun) {
        process.stderr.write(`  [gh DRY-RUN] pr upsert: draft PR for ${meta.branch} (Refs #${issueNum})\n`);
      } else {
        const pr = await updatePullRequest(
          {
            root: session.root,
            branch: meta.branch ?? snap.branch,
            remote: flagStr(args, 'remote') ?? cfg.remote,
            draft: !flagBool(args, 'no-draft') && cfg.draftPr,
            push: flagBool(args, 'push'),
            sourceIssue: issueNum,
            ...(flagStr(args, 'base') ? { baseBranch: flagStr(args, 'base')! } : {}),
          },
          snap,
          session.pm,
        );
        process.stdout.write(`${pr.created ? 'Created' : pr.updated ? 'Updated' : 'Existing'} draft PR: ${pr.url}\n`);
      }
    }
  } finally {
    releaseRunLock(session.paths.runLock);
  }

  for (const w of warnings) process.stderr.write(`  warning: ${w}\n`);
  process.stdout.write(`\nRun ${finalState} for ${repo}#${issueNum}. Report: ${reportPath}\n`);
  process.stdout.write('Completion = verified-completed/total slices. agent-loop never auto-merges or deploys.\n');
  return exitCodeForState(finalState);
}

/** Apply a run-state status label (precise add/remove) + optional board column. */
async function setRunStatus(
  client: GhClient,
  cfg: GithubConfig,
  repo: string,
  issueNum: number,
  labelSet: Set<string>,
  state: RunState,
  syncProject: boolean,
  warnings: string[],
): Promise<void> {
  const target = statusLabelForRunState(state, cfg.labels);
  if (target) {
    const runStatusLabels = [cfg.labels.planReady, cfg.labels.running, cfg.labels.blocked, cfg.labels.done, cfg.labels.error];
    const toRemove = runStatusLabels.filter((l) => l !== target && labelSet.has(l));
    if (!labelSet.has(target)) {
      // Ensure the label exists (best-effort) so adding it can't fail on a fresh repo.
      await client.ensureLabel(repo, target, 'ededed', 'agent-loop status');
      await client.addLabels(repo, issueNum, [target]);
      labelSet.add(target);
    }
    if (toRemove.length) {
      await client.removeLabels(repo, issueNum, toRemove);
      for (const l of toRemove) labelSet.delete(l);
    }
  }
  if (syncProject) {
    const sync = await syncIssueStatus(client, repo, withProjectEnabled(cfg), issueNum, projectStatusForRunState(state));
    if (!sync.ok && sync.warning) warnings.push(sync.warning);
  }
}

// --- watch -------------------------------------------------------------------

async function githubWatch(session: Session, args: ParsedArgs): Promise<number> {
  const cfg = session.config.github;
  const repo = resolveRepo(args, cfg);
  const dryRun = isDryRun(args);
  const client = makeClient(session, dryRun);
  const paths = watchPaths(session.paths.dir, session.paths.controlDir);
  const mode = interviewModeFromArgs(args, undefined, cfg.triage.interviewMode);
  const common = {
    repo,
    mode,
    comment: flagBool(args, 'comment') || cfg.triage.commentClarifications,
    onlyTriggered: !flagBool(args, 'all'),
    syncProject: flagBool(args, 'project') || cfg.project.enabled,
  };

  if (flagBool(args, 'once') || (!flagNum(args, 'max-iterations') && !flagNum(args, 'interval'))) {
    const pass = await watchOnce(client, cfg, paths, common);
    printPass(repo, dryRun, pass);
    return 0;
  }

  // Polling mode: explicit opt-in, bounded, abortable.
  const maxIterations = flagNum(args, 'max-iterations') ?? 0;
  if (maxIterations === 0 && !flagBool(args, 'yes')) {
    throw new ControlError(
      'unbounded polling requires an explicit cap. Pass --max-iterations N (or --once). ' +
        'Add --yes to acknowledge an unbounded loop.',
    );
  }
  const intervalSeconds = flagNum(args, 'interval') ?? cfg.watch.intervalSeconds;
  const controller = new AbortController();
  const onSig = (): void => controller.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    const result = await watchLoop(client, cfg, paths, {
      ...common,
      intervalSeconds,
      maxIterations,
      signal: controller.signal,
      onPass: (p) => printPass(repo, dryRun, p),
    });
    process.stdout.write(`\nWatch finished after ${result.iterations} iteration(s).\n`);
    return 0;
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

function printPass(repo: string, dryRun: boolean, pass: { iteration: number; processed: number; skipped: number; considered: number; warnings: string[] }): void {
  process.stdout.write(
    `watch ${repo} #${pass.iteration} (${dryRun ? 'DRY-RUN' : 'APPLY'}): ${pass.processed} processed, ${pass.skipped} skipped, ${pass.considered} considered\n`,
  );
  for (const w of pass.warnings) process.stderr.write(`  warning: ${w}\n`);
}

// --- project sync ------------------------------------------------------------

function withProjectEnabled(gh: GithubConfig): GithubConfig {
  // Explicit project commands intend to use the board even if the config gate is off.
  return { ...gh, project: { ...gh.project, enabled: true } };
}

async function githubProject(session: Session, args: ParsedArgs): Promise<number> {
  const cfg = session.config.github;
  const repo = resolveRepo(args, cfg);
  const action = args.positionals[1];
  const dryRun = isDryRun(args);
  const client = makeClient(session, dryRun);

  if (action !== 'sync') {
    // Detection / status report.
    const info = await detectProject(client, repo, withProjectEnabled(cfg));
    if (!info) {
      process.stdout.write(`No GitHub Project (v2) detected for ${repo}. Board sync will be skipped (labels/PRs still work).\n`);
      return 0;
    }
    process.stdout.write(`Project: "${info.title}" (#${info.number}) — status options: ${Object.keys(info.options).join(', ') || '(none)'}\n`);
    return 0;
  }

  const issueNum = requireIssue(args);
  const statusFlag = flagStr(args, 'status');
  let status: ProjectStatus;
  if (statusFlag) {
    if (!(PROJECT_STATUSES as readonly string[]).includes(statusFlag)) {
      throw new IntakeError(`--status must be one of: ${PROJECT_STATUSES.join(', ')}`);
    }
    status = statusFlag as ProjectStatus;
  } else {
    // Derive from the current local run state if available, else default to Ready.
    const meta = loadRunMeta(session.paths);
    const snap = meta ? projectEvents(session.store.read(meta.runId)) : undefined;
    status = snap ? projectStatusForRunState(snap.runState) : 'Ready';
  }

  const result = await syncIssueStatus(client, repo, withProjectEnabled(cfg), issueNum, status);
  if (result.ok) {
    process.stdout.write(`${dryRun ? 'Would move' : 'Moved'} #${issueNum} → ${status} on the project board.\n`);
  } else {
    process.stdout.write(`Project sync skipped: ${result.warning}\n`);
  }
  return 0;
}

// --- pr create / update ------------------------------------------------------

async function githubPr(session: Session, args: ParsedArgs): Promise<number> {
  const cfg = session.config.github;
  const action = args.positionals[1];
  if (action !== 'create' && action !== 'update') {
    process.stdout.write('Usage: agent-loop github pr <create|update> --repo o/n [--issue N] [--push] [--no-draft]\n');
    return action ? 1 : 0;
  }
  const meta = loadRunMeta(session.paths);
  if (!meta?.branch) throw new ControlError('no run branch found; plan/run first.');
  const store = new SqliteEventStore(session.paths.eventsDb);
  try {
    const snap = projectEvents(store.read(meta.runId));
    const issueNum = flagNum(args, 'issue');
    const opts = {
      root: session.root,
      branch: meta.branch,
      remote: flagStr(args, 'remote') ?? cfg.remote,
      draft: !flagBool(args, 'no-draft') && cfg.draftPr,
      push: flagBool(args, 'push'),
      ...(issueNum !== undefined ? { sourceIssue: issueNum } : {}),
      ...(flagStr(args, 'base') ? { baseBranch: flagStr(args, 'base')! } : {}),
    };
    if (flagBool(args, 'dry-run')) {
      process.stdout.write(`[DRY-RUN] would ${action} a ${opts.draft ? 'draft ' : ''}PR for ${meta.branch}${issueNum ? ` (Refs #${issueNum})` : ''}.\n`);
      return 0;
    }
    const result = action === 'update' ? await updatePullRequest(opts, snap, session.pm) : await createPullRequest(opts, snap, session.pm);
    store.append({
      runId: meta.runId,
      type: 'PR_CREATED',
      source: 'github',
      idempotencyKey: `pr:${meta.branch}:${result.url}:${result.updated ? 'updated' : result.created ? 'created' : 'existing'}`,
      payload: { url: result.url, created: result.created, updated: result.updated ?? false, branch: meta.branch },
    });
    process.stdout.write(`${result.created ? 'Created' : result.updated ? 'Updated' : 'Existing'} PR: ${result.url}\n`);
    return 0;
  } finally {
    store.close();
  }
}
