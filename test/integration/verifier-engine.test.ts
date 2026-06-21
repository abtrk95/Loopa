import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario, cleanupRepos, git } from '../helpers.js';

afterEach(cleanupRepos);

function story(id: string, allowedPaths: string[], extra: Record<string, unknown> = {}): object {
  return { id, title: `t-${id}`, description: 'd', acceptanceCriteria: ['c'], allowedPaths, ...extra };
}

describe('deterministic verifier controls completion', () => {
  it('rejects out-of-scope edits and never commits them', async () => {
    const r = await runScenario({
      prd: { description: 'x', userStories: [story('U', ['src/allowed/**'])] },
      // worker writes OUTSIDE allowedPaths
      fake: { slices: { 'S-001': { files: { 'src/forbidden/evil.js': 'x' } } }, reviews: {} },
    });
    expect(r.finalState).toBe('BLOCKED');
    expect(r.snapshot.verifiedCompleted).toBe(0);
    expect(git(r.root, ['log', '--format=%s'])).not.toContain('t-U');
    expect(existsSync(join(r.root, 'src/forbidden/evil.js'))).toBe(false); // rolled back
  });

  it('blocks (never commits) when a secret appears in the diff', async () => {
    const r = await runScenario({
      prd: { description: 'x', userStories: [story('U', ['src/**'])] },
      fake: { slices: { 'S-001': { files: { 'src/config.js': 'const key = "ghp_' + 'a'.repeat(30) + '";\n' } } }, reviews: {} },
    });
    expect(r.finalState).toBe('BLOCKED');
    expect(r.snapshot.blocker?.reason).toMatch(/secret/i);
  });

  it('blocks on writes under .git (structural escape)', async () => {
    const r = await runScenario({
      prd: { description: 'x', userStories: [story('U', ['**'])] },
      fake: { slices: { 'S-001': { files: { '.git/hooks/evil': 'x' } } }, reviews: {} },
    });
    expect(r.finalState).toBe('BLOCKED');
  });

  it('blocks on test weakening (.skip)', async () => {
    const r = await runScenario({
      prd: { description: 'x', userStories: [story('U', ['**'])] },
      fake: { slices: { 'S-001': { files: { 'foo.test.js': 'it.skip("x", () => {});\n' } } }, reviews: {} },
    });
    expect(r.finalState).toBe('BLOCKED');
    expect(r.snapshot.blocker?.reason).toMatch(/weakening|verification/i);
  });

  it('blocks when a required check fails, with no commit', async () => {
    const r = await runScenario({
      // failing test command
      files: { 'package.json': JSON.stringify({ name: 'f', scripts: { test: 'node -e "process.exit(1)"' } }) },
      prd: { description: 'x', userStories: [story('U', ['src/**'])] },
      fake: { slices: { 'S-001': { files: { 'src/a.js': 'module.exports = 1;\n' } } }, reviews: {} },
    });
    expect(r.finalState).toBe('BLOCKED');
    expect(git(r.root, ['log', '--format=%s'])).not.toContain('t-U');
  });

  it('writes a blocker report explaining the objective reason', async () => {
    const r = await runScenario({
      prd: { description: 'x', userStories: [story('U', ['src/**'])] },
      fake: { slices: {}, reviews: {} }, // no changes
    });
    const report = join(r.root, '.agent-loop/reports/blocked-S-001.md');
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, 'utf8')).toMatch(/no file changes/);
  });
});

describe('retry + fixer loop', () => {
  it('recovers via a fix on the second attempt', async () => {
    const r = await runScenario({
      // test passes only when OK file exists
      files: { 'package.json': JSON.stringify({ name: 'f', scripts: { test: 'node -e "process.exit(require(\'fs\').existsSync(\'src/OK\')?0:1)"' } }) },
      prd: { description: 'x', userStories: [story('U', ['src/**'])] },
      fake: {
        slices: {
          'S-001': {
            attempts: [
              { files: { 'src/a.js': 'module.exports = 1;\n' } }, // attempt 1: no OK → test fails
              { files: { 'src/a.js': 'module.exports = 1;\n', 'src/OK': 'ok\n' } }, // attempt 2 (fixer): test passes
            ],
          },
        },
        reviews: {},
      },
    });
    expect(r.finalState).toBe('COMPLETED');
    expect(r.snapshot.slices['S-001']?.retries).toBe(1);
    expect(git(r.root, ['log', '--format=%s'])).toContain('t-U');
  });
});

describe('reviewer integration (advisory, never overrides verifier)', () => {
  it('blocks when the reviewer returns "blocked"', async () => {
    const r = await runScenario({
      prd: { description: 'x', userStories: [story('U', ['src/**'])] },
      fake: { slices: { 'S-001': { files: { 'src/a.js': '1' } } }, reviews: { 'S-001': { verdict: 'blocked', findings: [], summary: 'no' } } },
      cliOverrides: { roles: { reviewer: { provider: 'fake' } } },
    });
    expect(r.finalState).toBe('BLOCKED');
  });

  it('passes when the reviewer returns "pass"', async () => {
    const r = await runScenario({
      prd: { description: 'x', userStories: [story('U', ['src/**'])] },
      fake: { slices: { 'S-001': { files: { 'src/a.js': '1' } } }, reviews: { 'S-001': { verdict: 'pass', findings: [] } } },
      cliOverrides: { roles: { reviewer: { provider: 'fake' } } },
    });
    expect(r.finalState).toBe('COMPLETED');
  });
});
