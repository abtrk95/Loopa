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
  kind: 'skip' | 'only' | 'deleted-test-file' | 'removed-assertions';
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

/**
 * Detect test weakening in a diff: newly-added skip/only markers, deleted test
 * files, and removed assertions. Heuristic but conservative.
 */
export function detectTestWeakening(diff: string): TestWeakeningFinding[] {
  const findings: TestWeakeningFinding[] = [];
  const added = addedLines(diff);
  for (const line of added) {
    if (SKIP_PATTERNS.some((re) => re.test(line))) {
      findings.push({ kind: 'skip', detail: line.trim().slice(0, 120) });
    }
    if (ONLY_PATTERNS.some((re) => re.test(line))) {
      findings.push({ kind: 'only', detail: line.trim().slice(0, 120) });
    }
  }
  // Deleted test files: a hunk that nulls out a test file.
  const fileHeaders = diff.split('\n');
  for (let i = 0; i < fileHeaders.length; i++) {
    const line = fileHeaders[i]!;
    const m = line.match(/^--- a\/(.+)$/);
    if (m && isTestFile(m[1]!) && fileHeaders[i + 1]?.startsWith('+++ /dev/null')) {
      findings.push({ kind: 'deleted-test-file', detail: m[1]! });
    }
  }
  // Removed assertions: count expect(/assert lines removed vs added in test diffs.
  const removedAssertions = diff
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .filter((l) => /\b(expect|assert|require|t\.(Error|Fatal))\b/.test(l)).length;
  const addedAssertions = added.filter((l) => /\b(expect|assert|require|t\.(Error|Fatal))\b/.test(l)).length;
  if (removedAssertions > 0 && removedAssertions > addedAssertions) {
    findings.push({
      kind: 'removed-assertions',
      detail: `removed ${removedAssertions} assertion(s), added ${addedAssertions}`,
    });
  }
  return findings;
}
