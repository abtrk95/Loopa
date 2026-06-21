/**
 * Reviewer consensus across DISTINCT providers (T5), and the load-bearing safety
 * invariant: a reviewer consensus — however unanimous — can NEVER override a
 * deterministic verifier failure. The reviewer only runs after a verifier `pass`,
 * so a verifier `fail`/`block` short-circuits before any reviewer is consulted.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempRepo, writeFakeScript, cleanupRepos } from '../helpers.js';
import { openSession, loadRunMeta } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';
import { project } from '../../src/events/projection.js';
import { RESULT_MARKER } from '../../src/providers/types.js';

const stubDirs: string[] = [];
function stub(name: string, body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'al-rev-stub-'));
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

/** A reviewer-only stub CLI that always emits a passing structured verdict. */
function passReviewerStub(name: string): string {
  return stub(name, `#!/bin/sh\nprintf '%s {"verdict":"pass","findings":[],"summary":"${name} ok"}\\n' "${RESULT_MARKER}"\nexit 0\n`);
}

describe('reviewer consensus across distinct providers', () => {
  it('runs each DISTINCT reviewer once (different provider per vote)', async () => {
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/x.js': 'module.exports = 1;\n' }, summary: 'x' } }, reviews: {} });
    const rev2 = passReviewerStub('rev2');
    const rev3 = passReviewerStub('rev3');
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        // Distinct panel: the built-in fake reviewer + two stub CLIs.
        roles: { reviewers: [{ provider: 'fake' }, { provider: 'rev2' }, { provider: 'rev3' }] },
        providers: { rev2: { file: rev2, baseArgs: [] }, rev3: { file: rev3, baseArgs: [] } },
        execution: { retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd(['src/**']) }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('COMPLETED');
      const finished = session.store.read(runId).filter((e) => e.type === 'REVIEW_FINISHED');
      // One vote per distinct reviewer, with distinct providers.
      expect(finished.length).toBe(3);
      const providers = finished.map((e) => e.payload['provider']);
      expect(new Set(providers)).toEqual(new Set(['fake', 'rev2', 'rev3']));
    } finally {
      session.close();
    }
  });

  it('blocks when one DISTINCT reviewer in the panel blocks', async () => {
    const root = tempRepo();
    // fake reviewer passes; the stub reviewer blocks → consensus requires ALL pass.
    writeFakeScript(root, {
      slices: { 'S-001': { files: { 'src/x.js': 'module.exports = 1;\n' }, summary: 'x' } },
      reviews: { 'S-001': { verdict: 'pass', findings: [], summary: 'fake ok' } },
    });
    const blocker = stub('revblock', `#!/bin/sh\nprintf '%s {"verdict":"blocked","findings":[],"summary":"nope"}\\n' "${RESULT_MARKER}"\nexit 0\n`);
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        roles: { reviewers: [{ provider: 'fake' }, { provider: 'revblock' }] },
        providers: { revblock: { file: blocker, baseArgs: [] } },
        execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd(['src/**']) }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('BLOCKED');
      expect(project(session.store.read(runId)).verifiedCompleted).toBe(0);
    } finally {
      session.close();
    }
  });
});

describe('reviewer consensus cannot override the deterministic verifier', () => {
  it('blocks an out-of-scope change even when EVERY reviewer votes pass', async () => {
    const root = tempRepo();
    // Worker writes OUTSIDE allowedPaths → deterministic verifier fails before review.
    writeFakeScript(root, { slices: { 'S-001': { files: { 'evil/leak.js': 'module.exports = 1;\n' }, summary: 'x' } }, reviews: {} });
    const rev2 = passReviewerStub('rev2pass');
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        roles: { reviewers: [{ provider: 'fake' }, { provider: 'rev2pass' }] },
        providers: { rev2pass: { file: rev2, baseArgs: [] } },
        execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd(['src/**']) }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      // Deterministic verifier wins: out-of-scope → blocked, regardless of reviewers.
      expect(result.finalState).toBe('BLOCKED');
      const events = session.store.read(runId);
      expect(project(events).verifiedCompleted).toBe(0);
      // The reviewer panel never even ran — verify short-circuited first.
      expect(events.filter((e) => e.type === 'REVIEW_FINISHED').length).toBe(0);
      // And nothing was committed.
      expect(events.some((e) => e.type === 'COMMIT_CREATED')).toBe(false);
    } finally {
      session.close();
    }
  });

  it('blocks a secret in the diff even when EVERY reviewer votes pass', async () => {
    const root = tempRepo();
    // In-scope edit, but the content carries a credential-shaped secret → the
    // deterministic secret scan returns `block` before any reviewer runs.
    const secret = 'ghp_' + 'a'.repeat(30);
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/x.js': `const t = '${secret}';\n` }, summary: 'x' } }, reviews: {} });
    const rev2 = passReviewerStub('rev2sec');
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        roles: { reviewers: [{ provider: 'fake' }, { provider: 'rev2sec' }] },
        providers: { rev2sec: { file: rev2, baseArgs: [] } },
        execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd(['src/**']) }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('BLOCKED');
      const events = session.store.read(runId);
      expect(project(events).verifiedCompleted).toBe(0);
      expect(events.filter((e) => e.type === 'REVIEW_FINISHED').length).toBe(0);
      expect(events.some((e) => e.type === 'COMMIT_CREATED')).toBe(false);
    } finally {
      session.close();
    }
  });
});
