import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepo } from '../../src/git/repo.js';
import { ProcessManager } from '../../src/process/manager.js';

let dir: string;
const pm = new ProcessManager();

async function initRepo(d: string): Promise<GitRepo> {
  const repo = new GitRepo(d, pm);
  await pm.run(['git', 'init', '-q'], { cwd: d });
  await pm.run(['git', 'config', 'user.email', 't@t'], { cwd: d });
  await pm.run(['git', 'config', 'user.name', 't'], { cwd: d });
  writeFileSync(join(d, 'README.md'), '# base\n');
  await pm.run(['git', 'add', '-A'], { cwd: d });
  await pm.run(['git', 'commit', '-q', '-m', 'base'], { cwd: d });
  return repo;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'al-git-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GitRepo', () => {
  it('detects repo, branch, and clean state', async () => {
    const repo = await initRepo(dir);
    expect(await repo.isRepo()).toBe(true);
    expect(await repo.isClean()).toBe(true);
    expect(await repo.hasCommits()).toBe(true);
  });

  it('reports changed paths and added lines on a clean-tree baseline', async () => {
    const repo = await initRepo(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    expect(await repo.changedPaths()).toContain('src/a.ts');
    expect(await repo.addedLines()).toBeGreaterThanOrEqual(2);
  });

  it('creates a scoped commit of only the named paths', async () => {
    const repo = await initRepo(dir);
    writeFileSync(join(dir, 'wanted.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'unwanted.ts'), 'export const y = 1;\n');
    const commit = await repo.scopedCommit(['wanted.ts'], 'add wanted', 'S-001');
    expect(commit.sha).toMatch(/^[0-9a-f]{7,}/);
    // unwanted.ts is still uncommitted (only wanted.ts was staged)
    expect(await repo.changedPaths()).toEqual(['unwanted.ts']);
    const found = await repo.findSliceCommit('S-001');
    expect(found?.sha).toBe(commit.sha);
  });

  it('rolls back uncommitted work to the verified baseline', async () => {
    const repo = await initRepo(dir);
    const head = await repo.headSha();
    writeFileSync(join(dir, 'junk.ts'), 'junk\n');
    expect(await repo.isClean()).toBe(false);
    await repo.rollback();
    expect(await repo.isClean()).toBe(true);
    expect(await repo.headSha()).toBe(head);
  });

  it('isolates work in a worktree and integrates the commit', async () => {
    const repo = await initRepo(dir);
    await repo.createBranch('agent-loop/run');
    const base = await repo.headSha();
    // Worktree lives outside the repo tree (in production: the gitignored
    // .agent-loop/worktrees/ dir) so it never shows up as untracked in `status`.
    const wtPath = join(mkdtempSync(join(tmpdir(), 'al-wt-')), 'S-001');
    const wt = await repo.addWorktree(wtPath, 'aloop-wt/run-S-001', base);
    writeFileSync(join(wtPath, 'feature.ts'), 'export const f = 1;\n');
    const commit = await wt.scopedCommit(['feature.ts'], 'feat', 'S-001');
    const result = await repo.integrateCommit(commit.sha);
    expect(result).toBe('ok');
    expect((await repo.changedPaths()).length).toBe(0);
    await repo.removeWorktree(wtPath);
  });
});
