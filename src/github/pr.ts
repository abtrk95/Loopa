/**
 * GitHub pull-request creation via `gh`. Strictly opt-in and explicit: pushing and
 * PR creation happen ONLY when the user runs `agent-loop pr create`. We never
 * auto-merge or auto-deploy, and we avoid creating duplicate PRs.
 */
import { ProcessManager } from '../process/manager.js';
import { GitError } from '../domain/errors.js';
import type { RunSnapshot } from '../events/projection.js';
import { progressPercent } from '../events/projection.js';
import { renderHumanReviewSection } from './pr-review.js';

export interface CreatePrOptions {
  root: string;
  branch: string;
  remote: string;
  draft: boolean;
  push: boolean;
  baseBranch?: string;
  /** Source GitHub issue to reference (Refs #N — never "Closes", to avoid auto-close). */
  sourceIssue?: number;
}

export interface CreatePrResult {
  url: string;
  created: boolean;
  /** True when an existing PR was edited rather than created. */
  updated?: boolean;
}

export async function createPullRequest(opts: CreatePrOptions, snapshot: RunSnapshot, pm = new ProcessManager()): Promise<CreatePrResult> {
  // Avoid duplicates: reuse an existing PR for this branch if present.
  const existing = await pm.run(['gh', 'pr', 'list', '--head', opts.branch, '--json', 'url', '--limit', '1'], {
    cwd: opts.root,
    timeoutMs: 30_000,
  });
  if (existing.ok) {
    try {
      const list = JSON.parse(existing.stdout) as Array<{ url: string }>;
      if (list[0]?.url) return { url: list[0].url, created: false };
    } catch {
      // fall through to creation
    }
  }

  if (opts.push) {
    const push = await pm.run(['git', 'push', '-u', opts.remote, opts.branch], { cwd: opts.root, timeoutMs: 120_000 });
    if (!push.ok) {
      throw new GitError(`git push failed (exit ${push.exitCode})`, { details: { stderr: push.stderr.slice(0, 500) } });
    }
  }

  const args = ['pr', 'create', '--title', prTitle(snapshot), '--body', prBody(snapshot, opts.sourceIssue), '--head', opts.branch];
  if (opts.draft) args.push('--draft');
  if (opts.baseBranch) args.push('--base', opts.baseBranch);
  const res = await pm.run(['gh', ...args], { cwd: opts.root, timeoutMs: 60_000 });
  if (!res.ok) {
    throw new GitError(`gh pr create failed (exit ${res.exitCode}). Push the branch first (use --push) and ensure gh is authenticated.`, {
      details: { stderr: res.stderr.slice(0, 500) },
    });
  }
  const url = res.stdout.trim().split('\n').pop() ?? '';
  return { url, created: true };
}

/**
 * Upsert a PR for the branch: edit the existing one (refreshing title/body from the
 * verified snapshot) or create it if none exists. Never duplicates, never merges,
 * never deploys.
 */
export async function updatePullRequest(opts: CreatePrOptions, snapshot: RunSnapshot, pm = new ProcessManager()): Promise<CreatePrResult> {
  const list = await pm.run(['gh', 'pr', 'list', '--head', opts.branch, '--json', 'url,number', '--limit', '1'], {
    cwd: opts.root,
    timeoutMs: 30_000,
  });
  let existing: { url: string; number: number } | undefined;
  if (list.ok) {
    try {
      const arr = JSON.parse(list.stdout) as Array<{ url: string; number: number }>;
      if (arr[0]?.url) existing = arr[0];
    } catch {
      // fall through to create
    }
  }
  if (!existing) {
    return createPullRequest(opts, snapshot, pm);
  }
  const editArgs = ['pr', 'edit', String(existing.number), '--title', prTitle(snapshot), '--body', prBody(snapshot, opts.sourceIssue)];
  const res = await pm.run(['gh', ...editArgs], { cwd: opts.root, timeoutMs: 60_000 });
  if (!res.ok) {
    throw new GitError(`gh pr edit failed (exit ${res.exitCode}).`, { details: { stderr: res.stderr.slice(0, 500) } });
  }
  return { url: existing.url, created: false, updated: true };
}

function prTitle(s: RunSnapshot): string {
  return `agent-loop: ${s.goal.slice(0, 80)}`;
}

function prBody(s: RunSnapshot, sourceIssue?: number): string {
  const blocked = s.blocker ? [`**Blocked:** ${s.blocker.reason}`, ``] : [];
  const lines = [
    `## Summary`,
    `Autonomous implementation by agent-loop.`,
    ...(sourceIssue ? [``, `Refs #${sourceIssue}`] : []), // Refs (not Closes) — never auto-closes the issue.
    ``,
    // Plain-English, non-technical human-review section up top (verdict, checks,
    // risk, manual checklist, and the explicit "no auto-merge / human review" banner).
    renderHumanReviewSection(s, sourceIssue !== undefined ? { sourceIssue } : {}),
    ``,
    `<details>`,
    `<summary>Technical details</summary>`,
    ``,
    `**Verified progress:** ${s.verifiedCompleted}/${s.totalSlices} slices (${progressPercent(s)}%)`,
    `**Run state:** ${s.runState}`,
    ``,
    ...blocked,
    `### Slices`,
    ...s.sliceOrder.map((id) => {
      const slice = s.slices[id];
      return slice ? `- ${id} ${slice.title} — ${slice.state}${slice.lastCommit ? ` (${slice.lastCommit.slice(0, 8)})` : ''}` : '';
    }),
    ``,
    `### Checks run`,
    ...(s.checks.length ? s.checks.map((c) => `- ${c.id}: ${c.state}`) : ['- (see run report)']),
    ``,
    `</details>`,
    ``,
    `> Completion is derived from deterministic verification + scoped commits, not agent claims.`,
    `> Review before merging. agent-loop does not auto-merge, deploy, or close the issue.`,
  ];
  return lines.join('\n');
}
