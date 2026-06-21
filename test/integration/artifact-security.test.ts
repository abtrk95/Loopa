/**
 * Artifact security (T4): secrets must never persist in ANY run artifact, and
 * sensitive run state must be owner-only where the OS enforces POSIX modes.
 *
 * The strongest possible proof: after a run that pushed a secret through the agent
 * blocker, the event store, the report, the blocker report, and (via context-pack
 * inlining) untrusted source — we recursively read EVERY file under `.agent-loop`
 * and assert the secret appears in none of them (SQLite db + WAL/SHM sidecars,
 * JSONL mirror, JSON/MD reports, context packs, logs, control, state). We also
 * assert the redaction placeholder IS present, so we're proving redaction ran (not
 * merely that the secret happened to be absent), and that the TUI snapshots
 * (`watch --json` / `--plain`) are clean.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch } from '../../src/watch/dashboard.js';
import { SqliteEventStore } from '../../src/events/store.js';
import { openSession, loadRunMeta } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';
import { runScenario, tempRepo, writeFakeScript, cleanupRepos } from '../helpers.js';

afterEach(cleanupRepos);

const isWin = process.platform === 'win32';

class MemoryWritable extends Writable {
  chunks: string[] = [];
  override _write(c: Buffer | string, _e: BufferEncoding, cb: (e?: Error) => void): void {
    this.chunks.push(c.toString());
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

// The fake provider's scripted input is test-only scaffolding (the secret's
// legitimate origin, like the user's own source). Real runs use real providers and
// have no such file, so it is excluded from the leak scan.
const SCAN_EXCLUDE = new Set(['fake-provider.json']);

/** Read every file under a dir tree as bytes (for substring scanning). */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SCAN_EXCLUDE.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function assertSecretAbsentInTree(dir: string, secret: string): { files: number; redactedSeen: boolean } {
  const needle = Buffer.from(secret, 'utf8');
  let redactedSeen = false;
  const files = allFiles(dir);
  for (const f of files) {
    const buf = readFileSync(f);
    expect(buf.includes(needle), `secret leaked into ${f}`).toBe(false);
    if (buf.includes(Buffer.from('***REDACTED***'))) redactedSeen = true;
  }
  return { files: files.length, redactedSeen };
}

const onePrd = (paths: string[]) =>
  ({ description: 'one slice', userStories: [{ id: 'U', title: 'do it', description: 'd', acceptanceCriteria: ['c'], allowedPaths: paths }] });

describe('secrets never persist in any run artifact', () => {
  it('redacts a secret across SQLite, JSONL, reports, blocker report, and TUI snapshots', async () => {
    const secret = 'ghp_' + 'A'.repeat(34);
    // The agent emits a blocker carrying a secret → flows into SLICE_BLOCKED,
    // the report, the blocker report, and the dashboard's rendered blocker line.
    const r = await runScenario({
      prd: onePrd(['src/**']),
      fake: { slices: { 'S-001': { blocker: `crashed with token ${secret}` } }, reviews: {} },
    });
    expect(r.finalState).toBe('BLOCKED');

    const agentDir = join(r.root, '.agent-loop');
    const { redactedSeen } = assertSecretAbsentInTree(agentDir, secret);
    expect(redactedSeen).toBe(true); // redaction demonstrably ran somewhere

    // Spot-check the named channels explicitly (in addition to the tree scan).
    const jsonl = readFileSync(join(agentDir, 'events/events.jsonl'), 'utf8');
    expect(jsonl).not.toContain(secret);
    expect(jsonl).toContain('***REDACTED***');
    expect(readFileSync(join(agentDir, 'reports/report.md'), 'utf8')).not.toContain(secret);
    expect(readFileSync(join(agentDir, 'reports/blocked-S-001.md'), 'utf8')).not.toContain(secret);

    // TUI snapshots (machine + plain) are clean.
    const j = new MemoryWritable();
    await runWatch({ root: r.root, once: true, json: true, out: j });
    expect(j.text()).not.toContain(secret);
    const p = new MemoryWritable();
    await runWatch({ root: r.root, once: true, out: p });
    expect(p.text()).not.toContain(secret);
  });

  it('redacts secrets inlined from untrusted source into the context pack', async () => {
    const secret = 'sk-ant-' + 'B'.repeat(30);
    const root = tempRepo({ 'src/keep.js': `const k = '${secret}';\n` });
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/new.js': 'module.exports = 1;\n' } } }, reviews: {} });
    const session = openSession({ root, skipUserConfig: true, cliOverrides: { execution: { retryBackoffMs: 0, retryJitterMs: 0 } } });
    try {
      const { plan } = createPlan(session, { input: { kind: 'prd-json', text: JSON.stringify(onePrd(['src/**'])) }, auto: true });
      await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
    } finally {
      session.close();
    }
    // The context pack inlined src/keep.js (untrusted data) — redacted.
    const ctx = readFileSync(join(root, '.agent-loop/artifacts/context/S-001__a1.md'), 'utf8');
    expect(ctx).not.toContain(secret);
    expect(ctx).toContain('***REDACTED***');
    // Nothing under .agent-loop carries it (the legit copy lives only in src/keep.js).
    assertSecretAbsentInTree(join(root, '.agent-loop'), secret);
  });

  it('redacts environment-derived secrets in the session log', () => {
    const envSecret = 'env-super-secret-value-7654321';
    process.env['MY_TEST_API_KEY'] = envSecret;
    try {
      const root = tempRepo();
      const session = openSession({ root, skipUserConfig: true });
      try {
        session.logger.info(`leaking ${envSecret} and ghp_${'C'.repeat(30)}`);
      } finally {
        session.close();
      }
      const log = readFileSync(join(root, '.agent-loop/artifacts/logs/agent-loop.log'), 'utf8');
      expect(log).not.toContain(envSecret);
      expect(log).toContain('***REDACTED***');
    } finally {
      delete process.env['MY_TEST_API_KEY'];
    }
  });
});

describe('sensitive run state is owner-only (POSIX)', () => {
  it.skipIf(isWin)('creates .agent-loop dirs 0700 and state files 0600', async () => {
    const r = await runScenario({
      prd: onePrd(['src/**']),
      fake: { slices: { 'S-001': { files: { 'src/x.js': '1\n' } } }, reviews: {} },
    });
    const agentDir = join(r.root, '.agent-loop');
    const dirOther = (p: string): number => statSync(p).mode & 0o077;
    // Directories: no group/other access.
    expect(dirOther(agentDir)).toBe(0);
    expect(dirOther(join(agentDir, 'events'))).toBe(0);
    expect(dirOther(join(agentDir, 'artifacts'))).toBe(0);
    expect(dirOther(join(agentDir, 'state'))).toBe(0);
    // Sensitive files: no group/other access.
    expect(statSync(join(agentDir, 'events/events.db')).mode & 0o077).toBe(0);
    expect(statSync(join(agentDir, 'events/events.jsonl')).mode & 0o077).toBe(0);
    expect(statSync(join(agentDir, 'reports/report.md')).mode & 0o077).toBe(0);
  });

  it.skipIf(isWin)('keeps the SQLite WAL/SHM sidecars owner-only (while open)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-wal-'));
    const dbPath = join(dir, 'events.db');
    const store = new SqliteEventStore(dbPath);
    try {
      // A real write materializes the WAL/SHM sidecars.
      store.append({ runId: 'r', type: 'RUN_CREATED', source: 'orchestrator', payload: {} });
      expect(statSync(dbPath).mode & 0o077).toBe(0);
      // WAL/SHM are created lazily by the write above; assert them if present.
      if (existsSync(`${dbPath}-wal`)) expect(statSync(`${dbPath}-wal`).mode & 0o077).toBe(0);
      if (existsSync(`${dbPath}-shm`)) expect(statSync(`${dbPath}-shm`).mode & 0o077).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
