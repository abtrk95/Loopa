/**
 * Regression tests for verifyCommitSafety (audit findings C1 + C2, area 3 / 6): the
 * shared re-verification used by resume reconciliation and the executor's idempotent
 * commit reuse. A clean scoped commit passes; a commit that never went through scoped
 * verification (out-of-scope, secret, test-weakening, oversized, .git) must be rejected
 * so a planted/tampered `agent-loop-slice` trailer cannot advance a slice.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitRepo } from '../../src/git/repo.js';
import { verifyCommitSafety } from '../../src/verify/verifier.js';
import { SliceSchema, RiskPolicySchema, type Plan } from '../../src/domain/schemas.js';
import { defaultConfig } from '../../src/config/config.js';

const dirs: string[] = [];
function repoDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'al-vcs-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: d });
  writeFileSync(join(d, 'README.md'), '# base\n');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: d });
  return d;
}
function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', `${msg}\n\nagent-loop-slice: S-001\n`], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const slice = SliceSchema.parse({
  id: 'S-001',
  title: 't',
  description: 'd',
  acceptanceCriteria: ['x'],
  allowedPaths: ['src/**'],
});
const plan = { riskPolicy: RiskPolicySchema.parse({}) } as unknown as Plan;
const config = defaultConfig();

async function check(dir: string, sha: string): Promise<boolean> {
  const res = await verifyCommitSafety({ repo: new GitRepo(dir), slice, plan, config, sha });
  return res.ok;
}

describe('verifyCommitSafety', () => {
  it('accepts a clean, in-scope commit', async () => {
    const dir = repoDir();
    const sha = commit(dir, { 'src/ok.ts': 'export const x = 1\n' }, 'S-001 ok');
    expect(await check(dir, sha)).toBe(true);
  });

  it('rejects an out-of-scope commit', async () => {
    const dir = repoDir();
    const sha = commit(dir, { 'secrets/leak.ts': 'export const y = 2\n' }, 'S-001 sneaky');
    expect(await check(dir, sha)).toBe(false);
  });

  it('rejects a commit containing a secret', async () => {
    const dir = repoDir();
    const sha = commit(dir, { 'src/cfg.ts': "export const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123'\n" }, 'S-001 secret');
    expect(await check(dir, sha)).toBe(false);
  });

  it('rejects a commit that weakens a test', async () => {
    const dir = repoDir();
    const sha = commit(dir, { 'src/a.test.ts': 'it("x", () => { expect(true).toBe(true) })\n' }, 'S-001 weaken');
    expect(await check(dir, sha)).toBe(false);
  });

  it('rejects an oversized in-scope commit', async () => {
    const dir = repoDir();
    const big = Array.from({ length: 900 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    const sha = commit(dir, { 'src/big.ts': big }, 'S-001 huge');
    expect(await check(dir, sha)).toBe(false);
  });
});
