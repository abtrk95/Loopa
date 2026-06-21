import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';
import { loadRunMeta } from '../../src/orchestrator/session.js';
import { project } from '../../src/events/projection.js';
import { FixedClock } from '../../src/util/clock.js';
import { tempRepo, writeFakeScript, cleanupRepos, git } from '../helpers.js';

afterEach(cleanupRepos);

const PRD = JSON.stringify({
  project: 'demo',
  description: 'Add two small modules',
  userStories: [
    { id: 'US1', title: 'Add alpha', description: 'create alpha module', acceptanceCriteria: ['alpha exists'], priority: 1, allowedPaths: ['src/alpha.js'] },
    { id: 'US2', title: 'Add beta', description: 'create beta module', acceptanceCriteria: ['beta exists'], priority: 2, allowedPaths: ['src/beta.js'] },
  ],
});

describe('full run lifecycle (fake provider)', () => {
  it('idea→plan→slices→verify→commit→final→completed', async () => {
    const root = tempRepo();
    writeFakeScript(root, {
      slices: {
        'S-001': { files: { 'src/alpha.js': 'module.exports = 1;\n' }, summary: 'alpha' },
        'S-002': { files: { 'src/beta.js': 'module.exports = 2;\n' }, summary: 'beta' },
      },
      reviews: {},
    });
    const session = openSession({ root, skipUserConfig: true, clock: new FixedClock(1_000) });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: PRD }, auto: true });
      expect(plan.slices).toHaveLength(2);

      const meta = loadRunMeta(session.paths)!;
      expect(meta.runId).toBe(runId);

      const engine = new RunEngine(session, plan, meta);
      const result = await engine.start();

      expect(result.finalState).toBe('COMPLETED');
      const snap = project(session.store.read(runId));
      expect(snap.verifiedCompleted).toBe(2);
      expect(snap.progressFraction).toBe(1);

      // Real files exist and are committed; tree is clean.
      expect(existsSync(join(root, 'src/alpha.js'))).toBe(true);
      expect(existsSync(join(root, 'src/beta.js'))).toBe(true);
      const status = git(root, ['status', '--porcelain', '--untracked-files=all']).trim();
      const dirty = status.split('\n').filter((l) => l && !l.includes('.agent-loop'));
      expect(dirty).toEqual([]);

      // Two scoped commits with slice trailers exist.
      const log = git(root, ['log', '--format=%s%x1f%b', '-n', '5']);
      expect(log).toContain('S-001 Add alpha');
      expect(log).toContain('S-002 Add beta');
      expect(log).toContain('agent-loop-slice: S-001');

      // Report written.
      expect(existsSync(result.reportPath)).toBe(true);
      expect(readFileSync(result.reportPath, 'utf8')).toContain('2 / 2');
    } finally {
      session.close();
    }
  });

  it('blocks (does not commit) when the agent makes no changes', async () => {
    const root = tempRepo();
    writeFakeScript(root, { slices: {}, reviews: {} }); // no script → no edits
    const session = openSession({ root, skipUserConfig: true, cliOverrides: { execution: { retryBackoffMs: 0, retryJitterMs: 0 } } });
    try {
      const { plan, runId } = createPlan(session, {
        input: { kind: 'prd-json', text: JSON.stringify({ description: 'x', userStories: [{ id: 'U', title: 'noop', description: 'd', acceptanceCriteria: ['c'], allowedPaths: ['src/**'] }] }) },
        auto: true,
      });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('BLOCKED');
      const snap = project(session.store.read(runId));
      expect(snap.verifiedCompleted).toBe(0);
      // No slice commit created.
      const log = git(root, ['log', '--format=%s']);
      expect(log).not.toContain('noop');
    } finally {
      session.close();
    }
  });
});
