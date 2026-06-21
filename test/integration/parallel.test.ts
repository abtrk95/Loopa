import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario, cleanupRepos, git } from '../helpers.js';

afterEach(cleanupRepos);

describe('safe parallel execution via worktrees', () => {
  it('runs two independent slices concurrently and integrates both commits', async () => {
    const r = await runScenario({
      prd: {
        description: 'parallel',
        userStories: [
          { id: 'A', title: 'alpha', description: 'd', acceptanceCriteria: ['a'], allowedPaths: ['src/a/**'], parallelSafe: true },
          { id: 'B', title: 'beta', description: 'd', acceptanceCriteria: ['b'], allowedPaths: ['src/b/**'], parallelSafe: true },
        ],
      },
      fake: {
        slices: {
          'S-001': { files: { 'src/a/x.js': 'module.exports = "a";\n' } },
          'S-002': { files: { 'src/b/y.js': 'module.exports = "b";\n' } },
        },
        reviews: {},
      },
      cliOverrides: { execution: { concurrency: 2 } },
    });
    expect(r.finalState).toBe('COMPLETED');
    expect(r.snapshot.verifiedCompleted).toBe(2);
    expect(existsSync(join(r.root, 'src/a/x.js'))).toBe(true);
    expect(existsSync(join(r.root, 'src/b/y.js'))).toBe(true);
    const log = git(r.root, ['log', '--format=%s']);
    expect(log).toContain('S-001 alpha');
    expect(log).toContain('S-002 beta');
    // Clean integration, no stray worktrees left.
    const status = git(r.root, ['status', '--porcelain']).split('\n').filter((l) => l && !l.includes('.agent-loop'));
    expect(status).toEqual([]);
  });

  it('serializes slices with overlapping scope (no corruption)', async () => {
    const r = await runScenario({
      prd: {
        description: 'overlap',
        userStories: [
          { id: 'A', title: 'alpha', description: 'd', acceptanceCriteria: ['a'], allowedPaths: ['src/shared/**'], parallelSafe: true },
          { id: 'B', title: 'beta', description: 'd', acceptanceCriteria: ['b'], allowedPaths: ['src/shared/**'], parallelSafe: true },
        ],
      },
      fake: {
        slices: {
          'S-001': { files: { 'src/shared/a.js': '1\n' } },
          'S-002': { files: { 'src/shared/b.js': '2\n' } },
        },
        reviews: {},
      },
      cliOverrides: { execution: { concurrency: 2 } },
    });
    // Overlapping scopes force serialization; both still complete correctly.
    expect(r.finalState).toBe('COMPLETED');
    expect(r.snapshot.verifiedCompleted).toBe(2);
    expect(existsSync(join(r.root, 'src/shared/a.js'))).toBe(true);
    expect(existsSync(join(r.root, 'src/shared/b.js'))).toBe(true);
  });
});
