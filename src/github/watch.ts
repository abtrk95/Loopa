/**
 * GitHub watch: poll a repo and triage issues, safely.
 *
 * Safety-first design:
 *  - `--once` is the primitive; polling is opt-in and bounded.
 *  - dry-run is the default (the client is constructed dry-run unless --apply).
 *  - a lock file prevents two watchers running for the same project.
 *  - per-issue state makes passes IDEMPOTENT: an unchanged classification is
 *    skipped, so repeated `--once` (or polling) does no duplicate writes.
 *  - polling respects a max-iteration cap and an AbortSignal; it NEVER auto-merges
 *    or deploys (it only triages — labels, comments, optional board column).
 *  - every pass appends events to a JSONL log.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { atomicWriteJson, readJson, appendLine, PRIVATE_FILE_MODE } from '../util/fs.js';
import { acquireRunLock, releaseRunLock } from '../process/pidfile.js';
import type { GhClient } from './client.js';
import type { GithubConfig } from '../config/config.js';
import { classifyIssue, applyClassification, type TriageResult } from './triage.js';
import { triggerLabels, projectStatusForTriage } from './labels.js';
import { syncIssueStatus } from './project.js';
import { ControlError } from '../domain/errors.js';
import type { InterviewMode } from '../intake/interview.js';

export interface WatchPaths {
  agentDir: string;
  controlDir: string;
}

interface WatchState {
  /** issue number → last applied triage status. */
  processed: Record<string, string>;
}

export interface WatchOnceOptions {
  repo: string;
  mode: InterviewMode;
  comment: boolean;
  onlyTriggered: boolean;
  syncProject: boolean;
  limit?: number;
  nowIso?: () => string;
}

export interface WatchPassResult {
  iteration: number;
  considered: number;
  processed: number;
  skipped: number;
  results: TriageResult[];
  warnings: string[];
  dryRun: boolean;
}

function statePath(paths: WatchPaths): string {
  return join(paths.agentDir, 'github', 'watch-state.json');
}
function eventsPath(paths: WatchPaths): string {
  return join(paths.agentDir, 'github', 'watch-events.jsonl');
}
function lockPath(paths: WatchPaths): string {
  return join(paths.controlDir, 'github-watch.pid');
}

function loadState(paths: WatchPaths): WatchState {
  const p = statePath(paths);
  if (!existsSync(p)) return { processed: {} };
  try {
    const s = readJson<WatchState>(p);
    return { processed: s.processed ?? {} };
  } catch {
    return { processed: {} };
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

/** One idempotent triage pass. Skips issues whose classification is unchanged. */
export async function watchOnce(
  client: GhClient,
  cfg: GithubConfig,
  paths: WatchPaths,
  opts: WatchOnceOptions,
  iteration = 1,
): Promise<WatchPassResult> {
  const now = opts.nowIso ?? isoNow;
  const triggers = new Set(triggerLabels(cfg));
  const state = loadState(paths);
  const issues = await client.listIssues(opts.repo, { state: 'open', limit: opts.limit ?? 50 });

  const results: TriageResult[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let processed = 0;

  for (const issue of issues) {
    if (opts.onlyTriggered && !issue.labels.some((l) => triggers.has(l))) {
      skipped++;
      continue;
    }
    const result = classifyIssue(issue, opts.mode);
    const key = String(issue.number);
    if (state.processed[key] === result.status) {
      skipped++;
      results.push(result);
      continue;
    }
    await applyClassification(client, cfg, opts.repo, issue, result, { comment: opts.comment });
    if (opts.syncProject) {
      const sync = await syncIssueStatus(client, opts.repo, cfg, issue.number, projectStatusForTriage(result.status));
      if (!sync.ok && sync.warning) warnings.push(`#${issue.number}: ${sync.warning}`);
    }
    // Record processed state ONLY when we actually applied (not dry-run), so a
    // dry-run preview never suppresses the real apply later.
    if (!client.isDryRun) state.processed[key] = result.status;
    appendLine(
      eventsPath(paths),
      JSON.stringify({ ts: now(), iteration, issue: issue.number, status: result.status, dryRun: client.isDryRun }),
      { mode: PRIVATE_FILE_MODE },
    );
    processed++;
    results.push(result);
  }

  if (!client.isDryRun) atomicWriteJson(statePath(paths), state, { mode: PRIVATE_FILE_MODE });

  return { iteration, considered: results.length, processed, skipped, results, warnings, dryRun: client.isDryRun };
}

export interface WatchLoopOptions extends WatchOnceOptions {
  intervalSeconds: number;
  /** Hard cap on iterations. 0 = unlimited (must be an explicit opt-in by the caller). */
  maxIterations: number;
  signal?: AbortSignal;
  /** Injectable sleep (tests pass an immediate resolver). */
  sleep?: (ms: number) => Promise<void>;
  onPass?: (pass: WatchPassResult) => void;
  nowMs?: () => number;
}

export interface WatchLoopResult {
  iterations: number;
  passes: WatchPassResult[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Bounded polling loop with a single-watcher lock. Returns after `maxIterations`
 * passes (or when the signal aborts). Refuses to start if another live watcher
 * holds the lock for this project (duplicate-run prevention).
 */
export async function watchLoop(
  client: GhClient,
  cfg: GithubConfig,
  paths: WatchPaths,
  opts: WatchLoopOptions,
): Promise<WatchLoopResult> {
  const now = opts.nowMs ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const lock = acquireRunLock(lockPath(paths), 'github-watch', now());
  if (!lock.ok) {
    throw new ControlError(
      `another agent-loop github watch is active for this project (pid ${lock.holder.pid}). ` +
        `If it crashed, remove ${lockPath(paths)} and retry.`,
    );
  }
  const passes: WatchPassResult[] = [];
  try {
    let i = 0;
    while (opts.maxIterations === 0 || i < opts.maxIterations) {
      if (opts.signal?.aborted) break;
      i++;
      const pass = await watchOnce(client, cfg, paths, opts, i);
      passes.push(pass);
      opts.onPass?.(pass);
      if (opts.maxIterations !== 0 && i >= opts.maxIterations) break;
      if (opts.signal?.aborted) break;
      await sleep(opts.intervalSeconds * 1000);
    }
    return { iterations: passes.length, passes };
  } finally {
    releaseRunLock(lockPath(paths));
  }
}

export function watchPaths(agentDir: string, controlDir: string): WatchPaths {
  return { agentDir, controlDir };
}
