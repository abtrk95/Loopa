/**
 * Worktree pool for safe parallel slice execution. Each parallel slice gets its
 * own git worktree on its own branch off a shared base, so concurrent agents
 * never touch the primary worktree. Verified commits are integrated back onto the
 * run branch deterministically (cherry-pick) by the orchestrator.
 */
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { GitRepo } from './repo.js';

export interface WorktreeHandle {
  sliceId: string;
  path: string;
  branch: string;
  repo: GitRepo;
}

export class WorktreePool {
  private readonly handles = new Map<string, WorktreeHandle>();

  constructor(
    private readonly main: GitRepo,
    private readonly worktreesDir: string,
    private readonly runBranch: string,
  ) {}

  async acquire(sliceId: string, baseRef: string): Promise<WorktreeHandle> {
    const existing = this.handles.get(sliceId);
    if (existing) return existing;
    const safe = sliceId.replace(/[^A-Za-z0-9_-]/g, '_');
    const path = join(this.worktreesDir, safe);
    // Use a flat, sibling namespace so the branch never becomes a child path of
    // the run branch (git forbids a ref being both a file and a directory).
    const runToken = this.runBranch.replace(/[^A-Za-z0-9_-]/g, '-');
    const branch = `aloop-wt/${runToken}-${safe}`;
    // Clean any stale worktree at this path first.
    await this.main.removeWorktree(path);
    rmSyncSafe(path);
    const repo = await this.main.addWorktree(path, branch, baseRef);
    const handle: WorktreeHandle = { sliceId, path, branch, repo };
    this.handles.set(sliceId, handle);
    return handle;
  }

  async release(sliceId: string): Promise<void> {
    const handle = this.handles.get(sliceId);
    if (!handle) return;
    await this.main.removeWorktree(handle.path);
    rmSyncSafe(handle.path);
    this.handles.delete(sliceId);
  }

  async releaseAll(): Promise<void> {
    for (const id of [...this.handles.keys()]) {
      await this.release(id);
    }
    await this.main.pruneWorktrees();
  }
}

function rmSyncSafe(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
