/**
 * Shared test fixtures: a temporary git repo + a fake-provider script, so the
 * whole engine can be exercised deterministically with no API calls.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectPaths, ensureLayout } from '../src/util/paths.js';
import type { FakeScript } from '../src/providers/fake.js';
import { openSession, loadRunMeta } from '../src/orchestrator/session.js';
import { createPlan } from '../src/orchestrator/planning.js';
import { RunEngine } from '../src/orchestrator/run.js';
import { project, type RunSnapshot } from '../src/events/projection.js';
import type { RunState } from '../src/domain/states.js';

const created: string[] = [];

export function tempRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'al-e2e-'));
  created.push(dir);
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'test@agent-loop.local']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  const all: Record<string, string> = {
    'package.json': JSON.stringify(
      { name: 'fixture', version: '0.0.0', scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    ),
    'README.md': '# fixture\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'baseline']);
  return dir;
}

export function writeFakeScript(root: string, script: FakeScript): void {
  const paths = projectPaths(root);
  ensureLayout(paths);
  writeFileSync(join(paths.dir, 'fake-provider.json'), JSON.stringify(script, null, 2));
}

export function cleanupRepos(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

export interface ScenarioResult {
  finalState: RunState;
  snapshot: RunSnapshot;
  root: string;
  runId: string;
  reportPath: string;
}

/** Plan + run a fake-provider scenario to a terminal state; closes the session. */
export async function runScenario(opts: {
  prd: object;
  fake: FakeScript;
  files?: Record<string, string>;
  cliOverrides?: Record<string, unknown>;
}): Promise<ScenarioResult> {
  const root = tempRepo(opts.files);
  writeFakeScript(root, opts.fake);
  const baseOverrides = { execution: { retryBackoffMs: 0, retryJitterMs: 0 } };
  const session = openSession({
    root,
    skipUserConfig: true,
    cliOverrides: mergeOverrides(baseOverrides, opts.cliOverrides ?? {}),
  });
  try {
    const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: JSON.stringify(opts.prd) }, auto: true });
    const engine = new RunEngine(session, plan, loadRunMeta(session.paths)!);
    const result = await engine.start();
    return { finalState: result.finalState, snapshot: project(session.store.read(runId)), root, runId, reportPath: result.reportPath };
  } finally {
    session.close();
  }
}

function mergeOverrides(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (cur && typeof cur === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mergeOverrides(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
