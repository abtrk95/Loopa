/**
 * GitHub pull-request creation via `gh`. Strictly opt-in and explicit: pushing and
 * PR creation happen ONLY when the user runs `agent-loop pr create`. We never
 * auto-merge or auto-deploy, and we avoid creating duplicate PRs.
 */
import { ProcessManager } from '../process/manager.js';
import { GitError } from '../domain/errors.js';
import type { RunSnapshot } from '../events/projection.js';
import { progressPercent } from '../events/projection.js';

export interface CreatePrOptions {
  root: string;
  branch: string;
  remote: string;
  draft: boolean;
  push: boolean;
  baseBranch?: string;
}

export interface CreatePrResult {
  url: string;
  created: boolean;
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

  const args = ['pr', 'create', '--title', prTitle(snapshot), '--body', prBody(snapshot), '--head', opts.branch];
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

function prTitle(s: RunSnapshot): string {
  return `agent-loop: ${s.goal.slice(0, 80)}`;
}

function prBody(s: RunSnapshot): string {
  const lines = [
    `## Summary`,
    `Autonomous implementation by agent-loop.`,
    ``,
    `**Verified progress:** ${s.verifiedCompleted}/${s.totalSlices} slices (${progressPercent(s)}%)`,
    `**Run state:** ${s.runState}`,
    ``,
    `## Slices`,
    ...s.sliceOrder.map((id) => {
      const slice = s.slices[id];
      return slice ? `- ${id} ${slice.title} — ${slice.state}${slice.lastCommit ? ` (${slice.lastCommit.slice(0, 8)})` : ''}` : '';
    }),
    ``,
    `> Completion is derived from deterministic verification + scoped commits, not agent claims.`,
    `> Review before merging. agent-loop does not auto-merge or deploy.`,
  ];
  return lines.join('\n');
}
