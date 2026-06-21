import { describe, it, expect, afterEach } from 'vitest';
import { openSession, loadRunMeta, type Session } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';
import { ControlPlane } from '../../src/orchestrator/control.js';
import { project } from '../../src/events/projection.js';
import { tempRepo, writeFakeScript, cleanupRepos, git } from '../helpers.js';
import type { FakeScript } from '../../src/providers/fake.js';

afterEach(cleanupRepos);

const TWO_STORY_PRD = {
  description: 'two slices',
  userStories: [
    { id: 'A', title: 'alpha', description: 'd', acceptanceCriteria: ['a'], allowedPaths: ['src/a.js'] },
    { id: 'B', title: 'beta', description: 'd', acceptanceCriteria: ['b'], allowedPaths: ['src/b.js'] },
  ],
};

function openFast(root: string): Session {
  return openSession({ root, skipUserConfig: true, cliOverrides: { execution: { retryBackoffMs: 0, retryJitterMs: 0, maxRetriesPerSlice: 0 } } });
}

function subjectCount(root: string, needle: string): number {
  return git(root, ['log', '--format=%s']).split('\n').filter((l) => l.includes(needle)).length;
}

describe('crash recovery + resume', () => {
  it('resumes a blocked run and re-attempts the blocked slice without redoing completed work', async () => {
    const root = tempRepo();
    // First run: only S-001 has a script; S-002 blocks (no changes).
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/a.js': '1\n' } } }, reviews: {} });
    let session = openFast(root);
    const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: JSON.stringify(TWO_STORY_PRD) }, auto: true });
    const first = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
    expect(first.finalState).toBe('BLOCKED');
    expect(subjectCount(root, 'S-001 alpha')).toBe(1);
    session.close();

    // Provide the missing script and resume.
    const fixed: FakeScript = { slices: { 'S-001': { files: { 'src/a.js': '1\n' } }, 'S-002': { files: { 'src/b.js': '2\n' } } }, reviews: {} };
    writeFakeScript(root, fixed);
    session = openFast(root);
    try {
      const resumed = await new RunEngine(session, plan, loadRunMeta(session.paths)!).resume();
      expect(resumed.finalState).toBe('COMPLETED');
      // S-001 was NOT redone (still a single commit); S-002 is now committed.
      expect(subjectCount(root, 'S-001 alpha')).toBe(1);
      expect(subjectCount(root, 'S-002 beta')).toBe(1);
      expect(project(session.store.read(runId)).verifiedCompleted).toBe(2);
    } finally {
      session.close();
    }
  });

  it('resuming an already-completed run is an idempotent no-op', async () => {
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/a.js': '1\n' } }, 'S-002': { files: { 'src/b.js': '2\n' } } }, reviews: {} });
    const session = openFast(root);
    try {
      const { plan } = createPlan(session, { input: { kind: 'prd-json', text: JSON.stringify(TWO_STORY_PRD) }, auto: true });
      const r1 = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(r1.finalState).toBe('COMPLETED');
      const commitsBefore = git(root, ['rev-list', '--count', 'HEAD']).trim();
      const r2 = await new RunEngine(session, plan, loadRunMeta(session.paths)!).resume();
      expect(r2.finalState).toBe('COMPLETED');
      expect(git(root, ['rev-list', '--count', 'HEAD']).trim()).toBe(commitsBefore); // no duplicate commits
    } finally {
      session.close();
    }
  });
});

describe('control plane', () => {
  it('stop before start cancels the run and terminates without committing', async () => {
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/a.js': '1\n' } }, 'S-002': { files: { 'src/b.js': '2\n' } } }, reviews: {} });
    const session = openFast(root);
    try {
      const { plan } = createPlan(session, { input: { kind: 'prd-json', text: JSON.stringify(TWO_STORY_PRD) }, auto: true });
      new ControlPlane(session.paths.controlDir).requestStop(Date.now());
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('CANCELLED');
      expect(result.snapshot.verifiedCompleted).toBe(0);
    } finally {
      session.close();
    }
  });

  it('pauses and resumes through the control plane', async () => {
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/a.js': '1\n' } }, 'S-002': { files: { 'src/b.js': '2\n' } } }, reviews: {} });
    const session = openFast(root);
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: JSON.stringify(TWO_STORY_PRD) }, auto: true });
      const control = new ControlPlane(session.paths.controlDir);
      control.requestPause(Date.now()); // pause before the first batch
      const engine = new RunEngine(session, plan, loadRunMeta(session.paths)!);
      const promise = engine.start();
      // Wait for the engine to register the pause.
      await waitFor(() => project(session.store.read(runId)).runState === 'PAUSED', 4000);
      expect(project(session.store.read(runId)).runState).toBe('PAUSED');
      control.requestResume(Date.now());
      const result = await promise;
      expect(result.finalState).toBe('COMPLETED');
    } finally {
      session.close();
    }
  });
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
