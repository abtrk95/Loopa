import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegExp, matchesAny, evaluateScope, structuralScan } from '../../src/git/scope.js';
import { renderDashboard, renderPlain, formatDuration, stripAnsi, summarizeEvent } from '../../src/watch/render.js';
import type { RunSnapshot } from '../../src/events/projection.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'al-scope-'));
  dirs.push(d);
  return d;
}

describe('glob + scope policy', () => {
  it('matches ** and * correctly', () => {
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('.env*').test('.env.local')).toBe(true);
    expect(globToRegExp('**/*.key').test('a/b/c.key')).toBe(true);
  });
  it('evaluates allowed and forbidden', () => {
    const r = evaluateScope({ changedPaths: ['src/a.ts', '.env', 'infra/p.tf'], allowedPaths: ['src/**'], forbiddenPaths: ['infra/**'], globalForbidden: ['.env'] });
    expect(r.ok).toBe(false);
    expect(r.forbidden).toContain('.env');
    expect(r.forbidden).toContain('infra/p.tf');
  });
  it('passes when all within scope', () => {
    expect(evaluateScope({ changedPaths: ['src/a.ts'], allowedPaths: ['src/**'], forbiddenPaths: [], globalForbidden: [] }).ok).toBe(true);
  });
  it('matchesAny works across globs', () => {
    expect(matchesAny('tests/x.test.ts', ['src/**', 'tests/**'])).toBe(true);
  });
});

describe('structural scan', () => {
  it('flags .git writes, traversal, and symlink escapes', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'ok.ts'), 'x');
    symlinkSync('/etc/passwd', join(dir, 'evil-link'));
    const findings = structuralScan(dir, ['.git/config', '../escape.ts', 'evil-link', 'src/ok.ts']);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('git-internal');
    expect(kinds).toContain('traversal');
    expect(kinds).toContain('symlink-escape');
  });
  it('flags a binary file when flagBinary is on, and not a text file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    writeFileSync(join(dir, 'note.txt'), 'plain text, no NUL bytes\n');
    const findings = structuralScan(dir, ['logo.bin', 'note.txt'], { flagBinary: true });
    expect(findings.find((f) => f.path === 'logo.bin')?.kind).toBe('binary');
    expect(findings.some((f) => f.path === 'note.txt')).toBe(false);
  });
  it('does NOT flag a binary file when flagBinary is off', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'logo.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const findings = structuralScan(dir, ['logo.bin'], { flagBinary: false });
    expect(findings.some((f) => f.kind === 'binary')).toBe(false);
  });
});

const snap: RunSnapshot = {
  runId: 'r', runState: 'RUNNING', goal: 'Build billing dashboard', branch: 'agent-loop/billing',
  totalSlices: 18, verifiedCompleted: 7, progressFraction: 7 / 18, sliceOrder: ['S-008'],
  slices: { 'S-008': { id: 'S-008', title: 'Add invoice table', state: 'VERIFYING', provider: 'codex', attempts: 1, retries: 0 } },
  currentSliceId: 'S-008', currentPhase: 'verifying', currentProvider: 'codex',
  checks: [{ id: 'typecheck', command: 'tsc', state: 'passed' }, { id: 'tests', command: 'npm test', state: 'running', durationMs: 42000 }],
  changedFiles: ['src/billing/InvoiceTable.tsx'], lastCommit: { sha: 'a1b2c3d4', message: 'S-007 complete' },
  assumptions: [], costUsd: 0, tokens: 0, finished: false, startedAtMs: 0,
};

describe('dashboard render', () => {
  const model = { snapshot: snap, git: { branch: 'agent-loop/billing', clean: false, uncommitted: 4, lastCommit: { sha: 'a1b2c3d4', message: 'S-007 complete' } }, recentEvents: [], nowMs: 5_058_000 };

  it('renders at wide and compact widths without corruption', () => {
    for (const width of [120, 100, 80, 60, 50]) {
      const frame = stripAnsi(renderDashboard(model, { width, color: false }));
      expect(frame).toContain('agent-loop watch');
      expect(frame).toContain('RUNNING');
      expect(frame).toContain('7 / 18');
      // No rendered line should exceed the requested width.
      for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(width);
    }
  });
  it('shows progress percentage and the active slice', () => {
    const frame = stripAnsi(renderDashboard(model, { width: 100, color: false }));
    expect(frame).toContain('39%');
    expect(frame).toContain('S-008 Add invoice table');
  });
  it('--no-color produces no ANSI codes', () => {
    const frame = renderDashboard(model, { width: 100, color: false });
    expect(frame).toBe(stripAnsi(frame));
  });
  it('plain mode is concise text', () => {
    const p = renderPlain(model);
    expect(p).toContain('agent-loop watch — RUNNING');
    expect(p).toContain('progress: 7/18');
  });
  it('formats durations and summarizes events', () => {
    expect(formatDuration(5_058_000)).toBe('01:24:18');
    expect(summarizeEvent({ type: 'COMMIT_CREATED', payload: { sha: 'abcdef1234', message: 'x' } } as never)).toContain('abcdef12');
  });
});
