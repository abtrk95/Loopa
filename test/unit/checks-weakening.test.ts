/**
 * Regression tests for the hardened test-weakening + merge-conflict detection
 * (audit findings C4 + merge-conflict gap, area 6). The autonomous loop must not be
 * defeatable by neutralizing assertions in place.
 */
import { describe, it, expect } from 'vitest';
import { detectTestWeakening, detectMergeConflicts } from '../../src/verify/checks.js';

function diff(file: string, removed: string[], added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,3 +1,3 @@',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    '',
  ].join('\n');
}

describe('test weakening: in-place neutralization is detected', () => {
  it('flags a tautological expect(true).toBe(true) added in a test file', () => {
    const d = diff('src/math.test.ts', ['  expect(add(2,2)).toBe(4)'], ['  expect(true).toBe(true)']);
    const kinds = detectTestWeakening(d).map((f) => f.kind);
    expect(kinds).toContain('tautology');
  });

  it('flags expect(X).toBe(X) with identical args', () => {
    const d = diff('test/a.spec.ts', ['  expect(result).toBe(42)'], ['  expect(1).toBe(1)']);
    expect(detectTestWeakening(d).some((f) => f.kind === 'tautology')).toBe(true);
  });

  it('flags assert True / assertTrue(true)', () => {
    const d = diff('tests/test_x.py', ['    assert compute() == 7'], ['    assert True']);
    expect(detectTestWeakening(d).some((f) => f.kind === 'tautology')).toBe(true);
  });

  it('catches commenting-out an assertion (comment lines are not counted as assertions)', () => {
    const d = diff('src/a.test.ts', ['  expect(x).toBe(1)'], ['  // expect(x).toBe(1)']);
    expect(detectTestWeakening(d).some((f) => f.kind === 'removed-assertions')).toBe(true);
  });

  it('does NOT flag a genuine, stronger assertion', () => {
    const d = diff('src/a.test.ts', ['  expect(x).toBeDefined()'], ['  expect(x).toBe(99)']);
    const kinds = detectTestWeakening(d).map((f) => f.kind);
    expect(kinds).not.toContain('tautology');
    expect(kinds).not.toContain('removed-assertions');
  });

  it('still detects .skip / .only markers', () => {
    const d = diff('src/a.test.ts', [], ['  it.skip("x", () => {})', '  describe.only("y", () => {})']);
    const kinds = detectTestWeakening(d).map((f) => f.kind);
    expect(kinds).toContain('skip');
    expect(kinds).toContain('only');
  });

  it('does not flag a tautology-looking line in a NON-test file', () => {
    const d = diff('src/util.ts', [], ['  if (false) { /* dead */ }']);
    expect(detectTestWeakening(d).some((f) => f.kind === 'tautology')).toBe(false);
  });
});

describe('merge-conflict markers', () => {
  it('detects added conflict markers', () => {
    const d = diff('src/x.ts', [], ['<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> feature']);
    const hits = detectMergeConflicts(d);
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('does not flag normal markdown rules or equals usage', () => {
    const d = diff('README.md', [], ['const x = 1', '## Heading', 'a === b']);
    expect(detectMergeConflicts(d)).toEqual([]);
  });
});
