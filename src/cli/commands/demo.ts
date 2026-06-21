/**
 * `agent-loop demo` — a fully deterministic, no-credentials showcase. Creates a
 * throwaway git repo, plans a tiny multi-slice feature, runs the fake provider
 * (which makes real file edits), verifies, commits, shows the dashboard, and prints
 * the report path.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSession, loadRunMeta } from '../../orchestrator/session.js';
import { createPlan } from '../../orchestrator/planning.js';
import { RunEngine } from '../../orchestrator/run.js';
import { project } from '../../events/projection.js';
import { renderDashboard } from '../../watch/render.js';
import { runWatch } from '../../watch/dashboard.js';
import { exitCodeForState } from './run.js';
import { flagBool, type ParsedArgs } from '../args.js';

const PRD = {
  project: 'demo-calculator',
  description: 'Build a tiny calculator module with add, subtract, and an index',
  userStories: [
    { id: 'US1', title: 'Add the add() function', description: 'Create src/add.js exporting add(a,b)', acceptanceCriteria: ['src/add.js exports add'], priority: 1, allowedPaths: ['src/add.js'] },
    { id: 'US2', title: 'Add the subtract() function', description: 'Create src/subtract.js exporting subtract(a,b)', acceptanceCriteria: ['src/subtract.js exports subtract'], priority: 2, allowedPaths: ['src/subtract.js'] },
    { id: 'US3', title: 'Add the calculator index', description: 'Create src/index.js re-exporting add and subtract', acceptanceCriteria: ['src/index.js exports both'], priority: 3, allowedPaths: ['src/index.js'], dependencies: ['US1', 'US2'] },
  ],
};

const FAKE = {
  slices: {
    'S-001': { files: { 'src/add.js': 'module.exports.add = (a, b) => a + b;\n' }, summary: 'added add()' },
    'S-002': { files: { 'src/subtract.js': 'module.exports.subtract = (a, b) => a - b;\n' }, summary: 'added subtract()' },
    'S-003': { files: { 'src/index.js': "module.exports = { ...require('./add'), ...require('./subtract') };\n" }, summary: 'added index' },
  },
  reviews: {},
};

export async function cmdDemo(args: ParsedArgs): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-demo-'));
  const g = (a: string[]): void => {
    execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  };
  g(['init', '-q']);
  g(['config', 'user.email', 'demo@agent-loop.local']);
  g(['config', 'user.name', 'agent-loop demo']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  writeFileSync(join(dir, 'README.md'), '# demo calculator\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'baseline']);

  const session = openSession({ root: dir, skipUserConfig: true });
  try {
    mkdirSync(join(dir, '.agent-loop'), { recursive: true });
    writeFileSync(join(dir, '.agent-loop', 'fake-provider.json'), JSON.stringify(FAKE, null, 2));

    process.stdout.write(`agent-loop demo — throwaway repo at:\n  ${dir}\n\n`);
    const { plan } = createPlan(session, { input: { kind: 'prd-json', text: JSON.stringify(PRD) }, auto: true });
    const meta = loadRunMeta(session.paths)!;
    const engine = new RunEngine(session, plan, meta);

    const live = process.stdout.isTTY && !flagBool(args, 'no-watch');
    let finalState;
    if (live) {
      const enginePromise = engine.start().catch(() => undefined);
      await runWatch({ root: dir, runId: meta.runId, color: !flagBool(args, 'no-color'), exitWhenFinished: true });
      const r = await enginePromise;
      finalState = r?.finalState ?? 'FAILED';
    } else {
      const result = await engine.start();
      finalState = result.finalState;
      // Print one dashboard frame so the demo always shows the dashboard.
      const snap = project(session.store.read(meta.runId));
      const lastCommit = await session.git.lastCommit();
      const status = (await session.git.status()).filter((s) => !s.path.startsWith('.agent-loop'));
      const frame = renderDashboard(
        {
          snapshot: snap,
          git: { branch: snap.branch, clean: status.length === 0, uncommitted: status.length, lastCommit },
          recentEvents: session.store.recent(8, meta.runId),
          nowMs: Date.now(),
        },
        { width: Math.min(100, process.stdout.columns ?? 100), color: !flagBool(args, 'no-color') },
      );
      process.stdout.write('\n' + frame + '\n');
    }

    const result = project(session.store.read(meta.runId));
    process.stdout.write(`\nDemo finished: ${finalState} (${result.verifiedCompleted}/${result.totalSlices} slices verified).\n`);
    process.stdout.write(`Report:  ${session.paths.reportsDir}/report.md\n`);
    process.stdout.write(`Repo:    ${dir} (inspect with: git -C ${dir} log --oneline)\n`);
    return exitCodeForState(finalState);
  } finally {
    session.close();
  }
}
