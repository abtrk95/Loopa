/**
 * Pure detection functions used by the verifier. Each operates over the real git
 * diff / changed-path set — never over agent output — so results are objective and
 * reproducible.
 */
import { Redactor, REDACTION_PLACEHOLDER } from '../security/redact.js';

const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'go.sum',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
]);

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

export function isTestFile(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[tj]sx?$/.test(path) ||
    /(^|\/)tests?\//.test(path) ||
    /_test\.go$/.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.py$/.test(path)
  );
}

export function lockfilesIn(paths: readonly string[]): string[] {
  return paths.filter(isLockfile);
}

/** Lines added in a unified diff (without the leading '+'). */
export function addedLines(diff: string): string[] {
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

export interface SecretHit {
  snippet: string;
}

/** Detect newly-added secrets in a diff (operates on added lines only). */
export function detectSecretsInDiff(diff: string): SecretHit[] {
  const redactor = new Redactor();
  const hits: SecretHit[] = [];
  for (const line of addedLines(diff)) {
    const redacted = redactor.redact(line);
    if (redacted !== line && redacted.includes(REDACTION_PLACEHOLDER)) {
      hits.push({ snippet: redacted.trim().slice(0, 120) });
    }
  }
  return hits;
}

export interface TestWeakeningFinding {
  kind: 'skip' | 'only' | 'deleted-test-file' | 'removed-assertions' | 'tautology';
  detail: string;
}

const SKIP_PATTERNS = [
  /\.skip\s*\(/,
  /\bxit\s*\(/,
  /\bxdescribe\s*\(/,
  /\bit\.skip\b/,
  /\bdescribe\.skip\b/,
  /@pytest\.mark\.skip/,
  /\bt\.Skip\s*\(/,
  /\bt\.SkipNow\s*\(/,
];
const ONLY_PATTERNS = [/\.only\s*\(/, /\bfit\s*\(/, /\bfdescribe\s*\(/];

/** Assertions that always pass regardless of the code under test. */
const TAUTOLOGY_PATTERNS = [
  /\bexpect\s*\(\s*true\s*\)/,
  /\bexpect\s*\(\s*true\s*\)\s*\.\s*toBe(?:Truthy)?\s*\(/,
  /\bassert\s+True\b/,
  /\bassertTrue\s*\(\s*true\s*\)/i,
  /\bassert\s*\(\s*true\s*\)/,
  /\bif\s*\(\s*false\s*\)\s*\{/,
];

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
}

function isAssertionLine(line: string): boolean {
  return /\b(expect|assert|require|t\.(Error|Fatal))\b/.test(line);
}

/** A tautological/self-satisfying assertion (e.g. `expect(true).toBe(true)`, `expect(x).toBe(x)`). */
function isTautology(line: string): boolean {
  if (TAUTOLOGY_PATTERNS.some((re) => re.test(line))) return true;
  // expect(X).toBe(X) / toEqual(X) / toStrictEqual(X) with textually identical args.
  const m = line.match(/\bexpect\s*\(\s*([^)]*?)\s*\)\s*\.\s*to(?:Be|Equal|StrictEqual)\s*\(\s*([^)]*?)\s*\)/);
  return !!m && m[1] !== undefined && m[1].length > 0 && m[1] === m[2];
}

/**
 * Detect test weakening in a diff: newly-added skip/only markers, deleted test
 * files, in-place tautologies/neutralized assertions, and net assertion removal
 * (counting only real, non-comment assertions so that commenting out an assertion
 * registers as a removal). Heuristic but conservative.
 */
export function detectTestWeakening(diff: string): TestWeakeningFinding[] {
  const findings: TestWeakeningFinding[] = [];
  const lines = diff.split('\n');
  let currentFile = '';
  let removedAssertions = 0;
  let addedAssertions = 0;

  for (const raw of lines) {
    if (raw.startsWith('+++ b/')) {
      currentFile = raw.slice(6).trim();
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@')) continue;

    if (raw.startsWith('+')) {
      const line = raw.slice(1);
      if (SKIP_PATTERNS.some((re) => re.test(line))) findings.push({ kind: 'skip', detail: line.trim().slice(0, 120) });
      if (ONLY_PATTERNS.some((re) => re.test(line))) findings.push({ kind: 'only', detail: line.trim().slice(0, 120) });
      if (isTestFile(currentFile) && !isCommentLine(line) && isTautology(line)) {
        findings.push({ kind: 'tautology', detail: line.trim().slice(0, 120) });
      }
      if (isAssertionLine(line) && !isCommentLine(line)) addedAssertions++;
    } else if (raw.startsWith('-')) {
      const line = raw.slice(1);
      if (isAssertionLine(line) && !isCommentLine(line)) removedAssertions++;
    }
  }

  // Deleted test files: a hunk that nulls out a test file.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^--- a\/(.+)$/);
    if (m && isTestFile(m[1]!) && lines[i + 1]?.startsWith('+++ /dev/null')) {
      findings.push({ kind: 'deleted-test-file', detail: m[1]! });
    }
  }

  if (removedAssertions > 0 && removedAssertions > addedAssertions) {
    findings.push({
      kind: 'removed-assertions',
      detail: `removed ${removedAssertions} assertion(s), added ${addedAssertions}`,
    });
  }
  return findings;
}

/** Detect unresolved merge-conflict markers introduced as added lines. */
export function detectMergeConflicts(diff: string): string[] {
  const hits: string[] = [];
  for (const line of addedLines(diff)) {
    if (/^(<{7}|>{7}|={7})(\s|$)/.test(line)) hits.push(line.trim().slice(0, 80));
  }
  return hits;
}
