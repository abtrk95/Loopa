/**
 * Regression test for symlink containment (audit finding C6, area 6 / 15): in-tree
 * symlinks must NOT be misclassified as escapes — including when the repo lives under
 * a symlinked path (macOS /var -> /private/var, /tmp, synced homes) — while symlinks
 * whose target escapes the repo must still be blocked.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuralScan } from '../../src/git/scope.js';

const dirs: string[] = [];
function tmp(): string {
  // mkdtemp under the OS temp dir, which on macOS is itself under a symlink (/var).
  const d = mkdtempSync(join(tmpdir(), 'al-symlink-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('structuralScan symlink classification', () => {
  it('classifies an in-tree relative symlink as a benign symlink (not an escape)', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'real.txt'), 'hello');
    symlinkSync('real.txt', join(dir, 'link.txt'));
    const findings = structuralScan(dir, ['link.txt']);
    const link = findings.find((f) => f.path === 'link.txt');
    expect(link?.kind).toBe('symlink');
  });

  it('resolves a relative target against the link own directory (nested, in-tree)', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src/deep'), { recursive: true });
    writeFileSync(join(dir, 'src/keep.txt'), 'k');
    symlinkSync('../keep.txt', join(dir, 'src/deep/y.lnk'));
    const findings = structuralScan(dir, ['src/deep/y.lnk']);
    expect(findings.find((f) => f.path === 'src/deep/y.lnk')?.kind).toBe('symlink');
  });

  it('still blocks a symlink whose target escapes the repo', () => {
    const dir = tmp();
    symlinkSync('/etc/passwd', join(dir, 'escape.lnk'));
    const findings = structuralScan(dir, ['escape.lnk']);
    expect(findings.find((f) => f.path === 'escape.lnk')?.kind).toBe('symlink-escape');
  });

  it('still blocks a relative symlink that climbs out of the repo', () => {
    const dir = tmp();
    symlinkSync('../../outside-secret', join(dir, 'climb.lnk'));
    const findings = structuralScan(dir, ['climb.lnk']);
    expect(findings.find((f) => f.path === 'climb.lnk')?.kind).toBe('symlink-escape');
  });
});
