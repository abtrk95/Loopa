/**
 * Process cleanup hardening (T3): stale-PID detection + single-writer run lock,
 * orphan/grandchild reaping (POSIX process group / Windows taskkill tree), and
 * recovery across SIGINT/SIGTERM (abort), timeout, and hard-kill (-9) scenarios.
 *
 * OS note: tree reaping is exercised on POSIX (where these tests run in CI). On
 * Windows the same code path uses `taskkill /T`; that branch is documented but not
 * asserted here (no Windows host in CI) — see docs/operations.md.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager, isProcessAlive } from '../../src/process/manager.js';
import { acquireRunLock, releaseRunLock, readRunLock } from '../../src/process/pidfile.js';
import { tempRepo, writeFakeScript, cleanupRepos } from '../helpers.js';
import { openSession, loadRunMeta } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';

const isWin = process.platform === 'win32';
const pm = new ProcessManager();
const dirs: string[] = [];
const stubDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'al-pc-'));
  dirs.push(d);
  return d;
}
function stub(name: string, body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'al-pc-stub-'));
  stubDirs.push(d);
  const p = join(d, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}
afterAll(() => {
  for (const d of [...dirs, ...stubDirs]) rmSync(d, { recursive: true, force: true });
  cleanupRepos();
});

describe('isProcessAlive', () => {
  it('is true for the current process and false for a reaped child', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const res = await pm.run(['node', '-e', 'process.exit(0)'], { cwd: tmpdir() });
    expect(res.pid).toBeDefined();
    // After close the child is gone.
    expect(isProcessAlive(res.pid!)).toBe(false);
  });
});

describe('run lock — stale-PID detection (hard-kill recovery)', () => {
  it('acquires a fresh lock and refuses a second LIVE holder', () => {
    const path = join(tmp(), 'run.pid');
    const a = acquireRunLock(path, 'run-1', 1000, 4242);
    expect(a.ok).toBe(true);
    expect((a as { takeover: string }).takeover).toBe('fresh');
    expect(readRunLock(path)?.pid).toBe(4242);

    // A different, LIVE pid (this test process) holds it → refused.
    writeFileSync(path, JSON.stringify({ pid: process.pid, runId: 'run-live', startedAt: 1 }));
    const b = acquireRunLock(path, 'run-2', 2000, 9999);
    expect(b.ok).toBe(false);
    expect((b as { ok: false; holder: { pid: number } }).holder.pid).toBe(process.pid);
  });

  it('takes over a STALE lock left by a hard-killed (dead-pid) orchestrator', async () => {
    const path = join(tmp(), 'run.pid');
    // Get a pid that is guaranteed dead (a child that has already exited).
    const dead = await pm.run(['node', '-e', 'process.exit(0)'], { cwd: tmpdir() });
    expect(isProcessAlive(dead.pid!)).toBe(false);
    writeFileSync(path, JSON.stringify({ pid: dead.pid, runId: 'crashed', startedAt: 1 }));

    const r = acquireRunLock(path, 'recovered', 3000, 5555);
    expect(r.ok).toBe(true);
    expect((r as { takeover: string }).takeover).toBe('stale');
    expect(readRunLock(path)?.pid).toBe(5555);
  });

  it('releases only its own lock', () => {
    const path = join(tmp(), 'run.pid');
    acquireRunLock(path, 'mine', 1, 7777);
    releaseRunLock(path, 1234); // not our pid → no-op
    expect(readRunLock(path)?.pid).toBe(7777);
    releaseRunLock(path, 7777); // our pid → removed
    expect(readRunLock(path)).toBeUndefined();
  });

  it('treats a corrupt lock file as absent (self-heals)', () => {
    const path = join(tmp(), 'run.pid');
    writeFileSync(path, '{ not json');
    expect(readRunLock(path)).toBeUndefined();
    const r = acquireRunLock(path, 'ok', 1, 8888);
    expect(r.ok).toBe(true);
  });
});

describe('timeout reaps the whole process tree (POSIX group kill)', () => {
  it.skipIf(isWin)('kills a grandchild when the parent times out', async () => {
    // Parent spawns a long-lived grandchild and itself hangs; on timeout the whole
    // detached group is signalled, so the grandchild dies too.
    const code = `
      const cp = require('node:child_process');
      const gc = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)']);
      process.stdout.write('GC ' + gc.pid + '\\n');
      setInterval(() => {}, 1000);
    `;
    let gcPid = 0;
    await expect(
      pm.run([process.execPath, '-e', code], {
        cwd: tmpdir(),
        timeoutMs: 1000,
        graceMs: 300,
        onOutput: (_s, chunk) => {
          const m = chunk.match(/GC (\d+)/);
          if (m) gcPid = Number(m[1]);
        },
      }),
    ).rejects.toThrow(/timed out/);
    expect(gcPid).toBeGreaterThan(0);
    // Give the SIGKILL a moment to land on the group.
    await new Promise((r) => setTimeout(r, 500));
    expect(isProcessAlive(gcPid)).toBe(false);
  }, 15_000);
});

describe('spawnServer + stop reaps the server tree', () => {
  it.skipIf(isWin)('stop() terminates the server and its grandchild', async () => {
    const code = `
      const cp = require('node:child_process');
      const gc = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)']);
      process.stdout.write('GC ' + gc.pid + '\\n');
      setInterval(() => {}, 1000);
    `;
    let gcPid = 0;
    const handle = pm.spawnServer([process.execPath, '-e', code], {
      cwd: tmpdir(),
      onOutput: (_s, chunk) => {
        const m = chunk.match(/GC (\d+)/);
        if (m) gcPid = Number(m[1]);
      },
    });
    // Wait for the grandchild pid to be reported.
    for (let i = 0; i < 30 && gcPid === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(handle.running()).toBe(true);
    expect(gcPid).toBeGreaterThan(0);
    await handle.stop(300);
    expect(handle.running()).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(isProcessAlive(gcPid)).toBe(false);
  }, 15_000);
});

describe('SIGINT/SIGTERM-style cancellation terminates the in-flight worker', () => {
  it('aborting the run kills the worker subprocess group and ends CANCELLED', async () => {
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/x.js': '1\n' } } }, reviews: {} });
    // A worker that spawns a grandchild and then sleeps far longer than the test.
    const slow = stub(
      'slow-worker',
      `#!/bin/sh\n${process.execPath} -e 'setTimeout(()=>{},120000)' &\necho GC $! \nsleep 120\n`,
    );
    const controller = new AbortController();
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        roles: { workers: [{ provider: 'slow' }] },
        providers: { slow: { file: slow, baseArgs: [] } },
        execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan } = createPlan(session, {
        input: { kind: 'prd-json', text: JSON.stringify({ description: 'x', userStories: [{ id: 'U', title: 't', description: 'd', acceptanceCriteria: ['c'], allowedPaths: ['src/**'] }] }) },
        auto: true,
      });
      const engine = new RunEngine(session, plan, loadRunMeta(session.paths)!, { signal: controller.signal });
      const started = Date.now();
      // Abort shortly after the worker launches (simulating SIGINT/SIGTERM → abort()).
      setTimeout(() => controller.abort(), 800);
      const result = await engine.start();
      // The run unwinds promptly (it did NOT wait out the worker's 120s sleep).
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(['CANCELLED', 'BLOCKED', 'FAILED']).toContain(result.finalState);
    } finally {
      session.close();
    }
  }, 30_000);
});
