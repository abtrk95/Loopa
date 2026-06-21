import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '../..');
const BIN = resolve(PROJECT_ROOT, 'bin/agent-loop.ts');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

// Run from the project root (so `tsx` resolves) but target the temp repo via --root.
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

function gitIn(dir: string, a: string[]): void {
  execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'al-acc-'));
  dirs.push(dir);
  gitIn(dir, ['init', '-q']);
  gitIn(dir, ['config', 'user.email', 't@t']);
  gitIn(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acc', scripts: { test: 'node -e "process.exit(0)"' } }));
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

describe('CLI acceptance (real binary, fake provider)', () => {
  it('runs init → plan → run --auto → status → watch --json end to end', () => {
    const dir = repo();
    writeFileSync(
      join(dir, 'prd.json'),
      JSON.stringify({ description: 'demo', userStories: [{ id: 'A', title: 'add file', description: 'd', acceptanceCriteria: ['c'], allowedPaths: ['src/**'] }] }),
    );

    expect(cli(dir, ['init']).status).toBe(0);

    // Script the fake provider for the slice the planner will produce.
    writeFileSync(join(dir, '.agent-loop', 'fake-provider.json'), JSON.stringify({ slices: { 'S-001': { files: { 'src/a.js': 'module.exports = 1;\n' } } }, reviews: {} }));

    const plan = cli(dir, ['plan', '--prd', join(dir, 'prd.json')]);
    expect(plan.status).toBe(0);
    expect(plan.stdout).toContain('S-001');

    // A real user commits the init-created .gitignore and their PRD before
    // launching an autonomous run, so the engine starts from a clean tree
    // (rollback uses `git clean`, which would otherwise remove these).
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'chore: init agent-loop']);

    const run = cli(dir, ['run', '--auto']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('COMPLETED');

    const status = cli(dir, ['status', '--json']);
    const snap = JSON.parse(status.stdout);
    expect(snap.runState).toBe('COMPLETED');
    expect(snap.verifiedCompleted).toBe(1);

    const watch = cli(dir, ['watch', '--once', '--json']);
    expect(JSON.parse(watch.stdout).snapshot.runState).toBe('COMPLETED');

    // The slice was really committed.
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' });
    expect(log).toContain('S-001 add file');
    expect(existsSync(join(dir, 'src/a.js'))).toBe(true);
  });

  it('doctor reports a healthy environment', () => {
    const dir = repo();
    const res = cli(dir, ['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('node >= 22.5');
    expect(res.stdout).toContain('provider:fake');
  });
});
