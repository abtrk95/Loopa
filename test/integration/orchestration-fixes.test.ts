/**
 * Regression tests for orchestration-layer audit fixes:
 *  - C1: an agent self-commit (HEAD drift) is hard-blocked and undone.
 *  - C7: provider fallback (a failing provider fails over to the next in fallbackOrder).
 *  - C8: reviewer consensus actually runs N reviews and a blocked verdict blocks.
 *  - C5: a stale parallel-worktree branch does not brick worktree acquisition.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempRepo, writeFakeScript, cleanupRepos, git } from '../helpers.js';
import { openSession, loadRunMeta } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';
import { project } from '../../src/events/projection.js';
import { GitRepo } from '../../src/git/repo.js';
import { WorktreePool } from '../../src/git/worktree.js';

const stubDirs: string[] = [];
function stub(name: string, body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'al-stub-'));
  stubDirs.push(d);
  const p = join(d, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}
afterAll(() => {
  cleanupRepos();
  for (const d of stubDirs) rmSync(d, { recursive: true, force: true });
});

const onePrd = (paths: string[]) =>
  JSON.stringify({
    description: 'one slice',
    userStories: [{ id: 'U', title: 'do it', description: 'd', acceptanceCriteria: ['c'], allowedPaths: paths }],
  });

describe('C1: agent self-commit is blocked and undone', () => {
  it('blocks the slice when the worker creates its own commit', async () => {
    const root = tempRepo();
    const baseline = git(root, ['rev-parse', 'HEAD']).trim();
    const sneaky = stub(
      'sneaky',
      '#!/bin/sh\nmkdir -p src\necho "x" > src/added.ts\ngit add -A >/dev/null 2>&1\ngit -c user.email=a@b -c user.name=a -c commit.gpgsign=false commit -q -m "AGENT SELF COMMIT" >/dev/null 2>&1\nexit 0\n',
    );
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        roles: { workers: [{ provider: 'sneaky' }] },
        providers: { sneaky: { file: sneaky, baseArgs: [] } },
        execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd(['src/**']) }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('BLOCKED');
      const snap = project(session.store.read(runId));
      expect(snap.verifiedCompleted).toBe(0);
      expect(snap.blocker?.reason ?? '').toMatch(/own commit/i);
      // The self-commit was undone: HEAD is back at baseline, no such commit remains.
      expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(baseline);
      expect(git(root, ['log', '--format=%s', '-n', '20'])).not.toContain('AGENT SELF COMMIT');
    } finally {
      session.close();
    }
  });
});

describe('C7: provider fallback', () => {
  it('fails over to the next provider when the primary cannot produce a result', async () => {
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/x.js': 'module.exports = 1;\n' }, summary: 'x' } }, reviews: {} });
    const failer = stub('failer', '#!/bin/sh\nexit 1\n');
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        roles: { workers: [{ provider: 'failer' }] },
        routing: { fallbackOrder: ['fake'] },
        providers: { failer: { file: failer, baseArgs: [] } },
        execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd(['src/**']) }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('COMPLETED');
      const events = session.store.read(runId);
      const fellBackToFake = events.some(
        (e) => e.type === 'PROVIDER_SELECTED' && e.payload['fallback'] === true && e.payload['provider'] === 'fake',
      );
      expect(fellBackToFake).toBe(true);
    } finally {
      session.close();
    }
  });
});

describe('C8: reviewer consensus', () => {
  it('runs N reviews when reviewerConsensus > 1 and all pass', async () => {
    const root = tempRepo();
    writeFakeScript(root, {
      slices: { 'S-001': { files: { 'src/x.js': 'module.exports = 1;\n' }, summary: 'x' } },
      reviews: { 'S-001': { verdict: 'pass', findings: [], summary: 'ok' } },
    });
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: { roles: { reviewer: { provider: 'fake' } }, routing: { reviewerConsensus: 2 }, execution: { retryBackoffMs: 0, retryJitterMs: 0 } },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd(['src/**']) }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('COMPLETED');
      const reviews = session.store.read(runId).filter((e) => e.type === 'REVIEW_FINISHED');
      expect(reviews.length).toBe(2);
    } finally {
      session.close();
    }
  });

  it('blocks when a consensus reviewer returns blocked', async () => {
    const root = tempRepo();
    writeFakeScript(root, {
      slices: { 'S-001': { files: { 'src/x.js': 'module.exports = 1;\n' }, summary: 'x' } },
      reviews: { 'S-001': { verdict: 'blocked', findings: [], summary: 'no' } },
    });
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: { roles: { reviewer: { provider: 'fake' } }, routing: { reviewerConsensus: 2 }, execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0 } },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd(['src/**']) }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('BLOCKED');
      const snap = project(session.store.read(runId));
      expect(snap.verifiedCompleted).toBe(0);
    } finally {
      session.close();
    }
  });
});

describe('C5: stale parallel-worktree branch recovery', () => {
  it('acquire() succeeds even when a same-named worktree branch already exists', async () => {
    const root = tempRepo();
    const main = new GitRepo(root);
    const base = git(root, ['rev-parse', 'HEAD']).trim();
    // Simulate the orphan a crashed parallel batch leaves behind.
    git(root, ['branch', 'aloop-wt/run-S-001', base]);
    const wtDir = mkdtempSync(join(tmpdir(), 'al-wt-'));
    stubDirs.push(wtDir);
    const pool = new WorktreePool(main, wtDir, 'run');
    const handle = await pool.acquire('S-001', base);
    expect(handle.branch).toBe('aloop-wt/run-S-001');
    expect(await handle.repo.headSha()).toBe(base);
    await pool.releaseAll();
  });
});
