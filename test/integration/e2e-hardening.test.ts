/**
 * Integration regressions for the E2E-hardening fixes, each reproducing a real bug
 * found during production validation and asserting the fix:
 *  - git hooks are neutralised so a planted .git/hooks/* never executes during our commit,
 *  - an agent that writes under .git/ (a hook) is detected and the slice is BLOCKED,
 *  - config.yml riskPolicy.globalForbiddenPaths is honored (was silently ignored),
 *  - a stale control-plane 'stopped' intent, once cleared, no longer cancels a fresh run,
 *  - the real CLI reports the package version, surfaces structured logs, and rejects bad input.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openSession, loadRunMeta, type Session } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';
import { ControlPlane } from '../../src/orchestrator/control.js';
import { tempRepo, writeFakeScript, cleanupRepos, git } from '../helpers.js';

afterEach(cleanupRepos);

function openFast(root: string, overrides: Record<string, unknown> = {}): Session {
  return openSession({
    root,
    skipUserConfig: true,
    cliOverrides: { execution: { retryBackoffMs: 0, retryJitterMs: 0, maxRetriesPerSlice: 0 }, ...overrides },
  });
}

const oneStory = (allowedPaths: string[]) => ({
  description: 'hardening fixture',
  userStories: [{ id: 'A', title: 'do', description: 'd', acceptanceCriteria: ['c'], allowedPaths }],
});

async function runInProcess(session: Session, prd: object): Promise<string> {
  const { plan } = createPlan(session, { input: { kind: 'prd-json', text: JSON.stringify(prd) }, auto: true });
  const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
  return result.finalState;
}

describe('git hooks cannot execute during agent-loop commits (RCE fix)', () => {
  it('a planted executable post-commit hook does NOT fire during the run', async () => {
    const root = tempRepo();
    const hook = join(root, '.git', 'hooks', 'post-commit');
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho pwned > "${join(root, 'PWNED')}"\n`);
    chmodSync(hook, 0o755);

    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/a.js': 'module.exports=1;\n' } } }, reviews: {} });
    const session = openFast(root);
    try {
      expect(await runInProcess(session, oneStory(['src/a.js']))).toBe('COMPLETED');
      expect(existsSync(join(root, 'PWNED'))).toBe(false); // hook neutralised
      expect(git(root, ['log', '--format=%s'])).toContain('S-001 do'); // slice still committed
    } finally {
      session.close();
    }
  });

  it('an agent that writes under .git/ (a hook) is detected and the slice is BLOCKED', async () => {
    const root = tempRepo();
    writeFakeScript(root, {
      slices: { 'S-001': { files: { 'src/a.js': 'module.exports=1;\n', '.git/hooks/post-commit': '#!/bin/sh\n' } } },
      reviews: {},
    });
    const session = openFast(root);
    try {
      expect(await runInProcess(session, oneStory(['**']))).toBe('BLOCKED');
      expect(git(root, ['log', '--format=%s'])).not.toContain('S-001'); // never committed
      const blocker = readFileSync(join(session.paths.reportsDir, 'blocked-S-001.md'), 'utf8');
      expect(blocker.toLowerCase()).toContain('.git');
    } finally {
      session.close();
    }
  });
});

describe('config riskPolicy.globalForbiddenPaths is honored', () => {
  it('blocks a write to a config-forbidden path (and would otherwise commit it)', async () => {
    // Control: with no policy, writing danger/x.txt completes.
    const root1 = tempRepo();
    writeFakeScript(root1, { slices: { 'S-001': { files: { 'danger/x.txt': 'data longer than six\n' } } }, reviews: {} });
    const s1 = openFast(root1);
    try {
      expect(await runInProcess(s1, oneStory(['**']))).toBe('COMPLETED');
    } finally {
      s1.close();
    }

    // With config.riskPolicy.globalForbiddenPaths: ["danger/**"], the same write blocks.
    const root2 = tempRepo();
    writeFakeScript(root2, { slices: { 'S-001': { files: { 'danger/x.txt': 'data longer than six\n' } } }, reviews: {} });
    const s2 = openFast(root2, { riskPolicy: { globalForbiddenPaths: ['danger/**'] } });
    try {
      expect(await runInProcess(s2, oneStory(['**']))).toBe('BLOCKED');
      expect(git(root2, ['log', '--format=%s'])).not.toContain('S-001');
    } finally {
      s2.close();
    }
  });
});

describe('stale control intent does not sabotage a fresh run', () => {
  it('a cleared control plane lets a previously-stopped run complete', async () => {
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/a.js': '1\n' } } }, reviews: {} });
    const session = openFast(root);
    try {
      const control = new ControlPlane(session.paths.controlDir);
      control.requestStop(Date.now()); // stale 'stopped' from a prior process
      control.clear(); // what executeRun does at the start of a fresh CLI invocation
      expect(control.getDesired()).toBe('run');
      expect(await runInProcess(session, oneStory(['src/a.js']))).toBe('COMPLETED');
    } finally {
      session.close();
    }
  });
});

describe('real CLI: version, logs, bad input', () => {
  const PROJECT_ROOT = resolve(__dirname, '../..');
  const BIN = resolve(PROJECT_ROOT, 'bin/agent-loop.ts');
  function cli(targetRoot: string, args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync('node', ['--no-warnings=ExperimentalWarning', '--import', 'tsx', BIN, ...args, '--root', targetRoot], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
    }
  }

  it('--version prints the package.json version', () => {
    const root = tempRepo();
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
    const res = cli(root, ['--version']);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
  });

  it('logs surfaces structured events after a run (not "No logs yet")', () => {
    const root = tempRepo();
    writeFileSync(join(root, '.agent-loop-prd.json'), JSON.stringify(oneStory(['src/**'])));
    cli(root, ['init']);
    writeFileSync(join(root, '.agent-loop', 'fake-provider.json'), JSON.stringify({ slices: { 'S-001': { files: { 'src/a.js': '1\n' } } }, reviews: {} }));
    cli(root, ['plan', '--prd', join(root, '.agent-loop-prd.json')]);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'chore: init']);
    expect(cli(root, ['run', '--auto']).status).toBe(0);
    const logs = cli(root, ['logs']);
    expect(logs.status).toBe(0);
    expect(logs.stdout).not.toContain('No logs yet');
    expect(logs.stdout).toContain('RUN_COMPLETED');
  });

  it('rejects bad PRD input with a clear nonzero error', () => {
    const root = tempRepo();
    writeFileSync(join(root, 'empty.md'), '');
    const empty = cli(root, ['plan', '--prd', join(root, 'empty.md')]);
    expect(empty.status).not.toBe(0);
    expect(empty.stderr.toLowerCase()).toContain('empty');

    writeFileSync(join(root, 'arr.json'), '[]');
    const arr = cli(root, ['plan', '--prd', join(root, 'arr.json')]);
    expect(arr.status).not.toBe(0);
    expect(arr.stderr.toLowerCase()).toContain('object');

    const missing = cli(root, ['plan', '--prd', join(root, 'does-not-exist.md')]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr.toLowerCase()).toContain('cannot read');
  });
});
