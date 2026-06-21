/**
 * Git adapter. Git is a primary source of truth: the orchestrator reads the REAL
 * diff after every agent run rather than trusting the agent's file list, makes
 * scoped commits only after verification, and rolls back failed attempts.
 *
 * A GitRepo is bound to a working directory (the main worktree or a per-slice
 * worktree). All commands run shell-free through the ProcessManager.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { GitError } from '../domain/errors.js';
import { ProcessManager, type RunResult } from '../process/manager.js';
import type { Redactor } from '../security/redact.js';

export const SLICE_TRAILER = 'agent-loop-slice';

export interface CommitInfo {
  sha: string;
  message: string;
}

export interface FileStatus {
  path: string;
  /** Porcelain XY code, e.g. ' M', '??', 'A '. */
  code: string;
}

export class GitRepo {
  constructor(
    readonly dir: string,
    private readonly pm: ProcessManager = new ProcessManager(),
    private readonly redactor?: Redactor,
  ) {}

  withDir(dir: string): GitRepo {
    return new GitRepo(dir, this.pm, this.redactor);
  }

  private async git(args: string[], opts: { allowFail?: boolean; input?: string } = {}): Promise<RunResult> {
    const res = await this.pm.run(['git', ...args], {
      cwd: this.dir,
      timeoutMs: 120_000,
      ...(this.redactor ? { redactor: this.redactor } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
    if (!res.ok && !opts.allowFail) {
      throw new GitError(`git ${args.join(' ')} failed (exit ${res.exitCode})`, {
        details: { stderr: res.stderr.slice(0, 2000), args },
      });
    }
    return res;
  }

  async isRepo(): Promise<boolean> {
    const res = await this.git(['rev-parse', '--is-inside-work-tree'], { allowFail: true });
    return res.ok && res.stdout.trim() === 'true';
  }

  async currentBranch(): Promise<string> {
    const res = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return res.stdout.trim();
  }

  async headSha(): Promise<string> {
    const res = await this.git(['rev-parse', 'HEAD']);
    return res.stdout.trim();
  }

  async hasCommits(): Promise<boolean> {
    const res = await this.git(['rev-parse', '--verify', 'HEAD'], { allowFail: true });
    return res.ok;
  }

  /** Working-tree status as porcelain entries (modified + staged + untracked). */
  async status(): Promise<FileStatus[]> {
    const res = await this.git([
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    const out: FileStatus[] = [];
    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      let path = line.slice(3).trim();
      // Renames are "old -> new"; record the new path.
      const arrow = path.indexOf(' -> ');
      if (arrow >= 0) path = path.slice(arrow + 4);
      out.push({ path, code });
    }
    return out;
  }

  async isClean(): Promise<boolean> {
    return (await this.status()).length === 0;
  }

  /** Paths changed in the working tree relative to HEAD (the clean-tree invariant
   * means this equals the current slice's changes). */
  async changedPaths(): Promise<string[]> {
    return (await this.status()).map((s) => s.path);
  }

  /** Added-line count across tracked modifications and untracked files. */
  async addedLines(): Promise<number> {
    let added = 0;
    const numstat = await this.git(['diff', '--numstat', 'HEAD'], { allowFail: true });
    if (numstat.ok) {
      for (const line of numstat.stdout.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 1 && parts[0] && parts[0] !== '-') {
          added += Number(parts[0]) || 0;
        }
      }
    }
    const untracked = await this.git(['ls-files', '--others', '--exclude-standard'], { allowFail: true });
    if (untracked.ok) {
      for (const rel of untracked.stdout.split('\n')) {
        if (!rel.trim()) continue;
        try {
          const content = readFileSync(join(this.dir, rel), 'utf8');
          added += content.length === 0 ? 0 : content.split('\n').length;
        } catch {
          // binary or unreadable — skip line counting
        }
      }
    }
    return added;
  }

  /** Unified diff of the working tree vs HEAD (tracked changes only). */
  async diff(): Promise<string> {
    const res = await this.git(['diff', 'HEAD'], { allowFail: true });
    return res.stdout;
  }

  /**
   * Diff including untracked (new) files, represented as synthetic add-only hunks.
   * Used by the verifier's content scans (secrets, test weakening) and the reviewer
   * so brand-new files are never invisible to safety checks.
   */
  async diffWithUntracked(): Promise<string> {
    let out = await this.diff();
    const untracked = await this.git(['ls-files', '--others', '--exclude-standard'], { allowFail: true });
    if (!untracked.ok) return out;
    for (const rel of untracked.stdout.split('\n')) {
      if (!rel.trim()) continue;
      try {
        const content = readFileSync(join(this.dir, rel), 'utf8');
        out += `\ndiff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
        for (const line of content.split('\n')) out += `+${line}\n`;
      } catch {
        // binary/unreadable — skip
      }
    }
    return out;
  }

  async createBranch(name: string, opts: { from?: string } = {}): Promise<void> {
    const args = ['checkout', '-b', name];
    if (opts.from) args.push(opts.from);
    await this.git(args);
  }

  async branchExists(name: string): Promise<boolean> {
    const res = await this.git(['rev-parse', '--verify', `refs/heads/${name}`], { allowFail: true });
    return res.ok;
  }

  async checkout(ref: string): Promise<void> {
    await this.git(['checkout', ref]);
  }

  /** Stage ONLY the given paths and commit them. Returns the new commit sha. */
  async scopedCommit(paths: string[], message: string, sliceId: string): Promise<CommitInfo> {
    if (paths.length === 0) {
      throw new GitError('refusing to create an empty scoped commit', { details: { sliceId } });
    }
    await this.git(['add', '--', ...paths]);
    const full = `${message}\n\n${SLICE_TRAILER}: ${sliceId}\n`;
    await this.git([
      '-c',
      'user.name=agent-loop',
      '-c',
      'user.email=agent-loop@local',
      'commit',
      '--no-gpg-sign',
      '-m',
      full,
    ]);
    const sha = await this.headSha();
    return { sha, message };
  }

  /** Discard all uncommitted changes, restoring the last committed state. The
   * `-e .agent-loop` guard ensures we never delete our own run metadata even if it
   * is not yet git-ignored. */
  async rollback(): Promise<void> {
    await this.git(['reset', '--hard', 'HEAD']);
    await this.git(['clean', '-fd', '-e', '.agent-loop']);
  }

  async resetHardTo(sha: string): Promise<void> {
    await this.git(['reset', '--hard', sha]);
    await this.git(['clean', '-fd', '-e', '.agent-loop']);
  }

  /** Find a commit that already recorded the given slice (resume reconciliation). */
  async findSliceCommit(sliceId: string, limit = 300): Promise<CommitInfo | undefined> {
    const res = await this.git(
      ['log', `-n${limit}`, '--format=%H%x1f%B%x1e'],
      { allowFail: true },
    );
    if (!res.ok) return undefined;
    for (const record of res.stdout.split('\x1e')) {
      const [sha, body] = record.split('\x1f');
      if (!sha || !body) continue;
      if (body.includes(`${SLICE_TRAILER}: ${sliceId}`)) {
        const firstLine = body.trim().split('\n')[0] ?? '';
        return { sha: sha.trim(), message: firstLine };
      }
    }
    return undefined;
  }

  // --- worktrees (parallel slice isolation) ---------------------------------

  async addWorktree(path: string, branch: string, baseRef?: string): Promise<GitRepo> {
    const args = ['worktree', 'add', '-b', branch, path];
    if (baseRef) args.push(baseRef);
    await this.git(args);
    return this.withDir(path);
  }

  async removeWorktree(path: string): Promise<void> {
    await this.git(['worktree', 'remove', '--force', path], { allowFail: true });
  }

  async pruneWorktrees(): Promise<void> {
    await this.git(['worktree', 'prune'], { allowFail: true });
  }

  /** Cherry-pick a verified commit from a worktree branch onto the current branch.
   * Returns 'ok' or 'conflict' (in which case the cherry-pick is aborted). */
  async integrateCommit(sha: string): Promise<'ok' | 'conflict'> {
    const res = await this.git(
      ['-c', 'user.name=agent-loop', '-c', 'user.email=agent-loop@local', 'cherry-pick', sha],
      { allowFail: true },
    );
    if (res.ok) return 'ok';
    await this.git(['cherry-pick', '--abort'], { allowFail: true });
    return 'conflict';
  }

  async lastCommit(): Promise<CommitInfo | undefined> {
    if (!(await this.hasCommits())) return undefined;
    const res = await this.git(['log', '-1', '--format=%H%x1f%s'], { allowFail: true });
    if (!res.ok) return undefined;
    const [sha, subject] = res.stdout.trim().split('\x1f');
    return sha ? { sha, message: subject ?? '' } : undefined;
  }
}
