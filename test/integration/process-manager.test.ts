import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { ProcessManager } from '../../src/process/manager.js';
import { Redactor } from '../../src/security/redact.js';

const pm = new ProcessManager();
const cwd = tmpdir();

describe('ProcessManager', () => {
  it('captures stdout and exit code, executing without a shell', async () => {
    const res = await pm.run(['node', '-e', 'console.log("hello"); process.exit(0)'], { cwd });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello');
  });

  it('reports non-zero exit codes', async () => {
    const res = await pm.run(['node', '-e', 'process.exit(3)'], { cwd });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
  });

  it('redacts secrets in captured output', async () => {
    const res = await pm.run(['node', '-e', 'console.log("ghp_" + "a".repeat(30))'], { cwd, redactor: new Redactor() });
    expect(res.stdout).toContain('***REDACTED***');
    expect(res.stdout).not.toMatch(/ghp_a{30}/);
  });

  it('times out and kills the process group instead of hanging', async () => {
    const start = Date.now();
    await expect(pm.run(['node', '-e', 'setTimeout(()=>{}, 60000)'], { cwd, timeoutMs: 300, graceMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('cancels via AbortSignal', async () => {
    const ac = new AbortController();
    const p = pm.run(['node', '-e', 'setTimeout(()=>{}, 60000)'], { cwd, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const res = await p;
    expect(res.cancelled).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('bounds captured output', async () => {
    const res = await pm.run(['node', '-e', 'process.stdout.write("x".repeat(100000))'], { cwd, maxOutputBytes: 1000 });
    expect(res.stdout.length).toBeLessThanOrEqual(1000);
    expect(res.truncated).toBe(true);
  });

  it('does not inherit git-poisoning env vars', async () => {
    const res = await pm.run(['node', '-e', 'console.log("GIT_DIR=" + (process.env.GIT_DIR ?? "unset"))'], {
      cwd,
      env: {},
    });
    // GIT_DIR is stripped by filterEnv even if present in the parent.
    expect(res.stdout).toContain('GIT_DIR=unset');
  });
});
