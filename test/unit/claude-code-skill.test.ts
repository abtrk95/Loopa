/**
 * Static validation for the Claude Code operator skill.
 *
 * Claude Code skill *execution* cannot be exercised in CI (it runs inside the Claude
 * Code host), so we validate the contract statically: the skill file exists, carries
 * the required safety guarantees verbatim, and documents the key commands. This is the
 * automated half of the validation; the manual/pressure-scenario half lives in
 * reports/claude-code-skill-validation.md.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillDir = join(repoRoot, '.claude', 'skills', 'agent-loop');
const skillPath = join(skillDir, 'SKILL.md');

/** The raw skill text, lowercased with markdown backticks/asterisks and quotes stripped
 * and all whitespace runs collapsed to single spaces, so phrase assertions don't break on
 * emphasis/code formatting/quoting or on line wrapping. */
function normalizedSkill(): string {
  return readFileSync(skillPath, 'utf8').toLowerCase().replace(/[`*"“”]/g, '').replace(/\s+/g, ' ');
}

describe('claude code skill — file presence + frontmatter', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('has YAML frontmatter with name "agent-loop" and a "Use when" description', () => {
    const raw = readFileSync(skillPath, 'utf8');
    expect(raw.startsWith('---\n')).toBe(true);
    const fm = raw.slice(4, raw.indexOf('\n---', 4));
    expect(fm).toMatch(/^name:\s*agent-loop\s*$/m);
    expect(fm).toMatch(/^description:\s*Use when/m);
  });

  it('ships the human-facing README and the four worked examples', () => {
    expect(existsSync(join(skillDir, 'README.md'))).toBe(true);
    for (const ex of ['start-from-idea', 'github-issue-flow', 'review-pr', 'progress']) {
      expect(existsSync(join(skillDir, 'examples', `${ex}.md`))).toBe(true);
    }
  });
});

describe('claude code skill — required safety phrases', () => {
  // These are the non-negotiable guarantees. If any is missing the skill could mislead a
  // non-technical operator into an unsafe action, so the build must fail.
  const REQUIRED_SAFETY_PHRASES = [
    'no auto-merge',
    'no auto-deploy',
    'human review is required',
    'verifier remains final authority',
    'ask for confirmation before any --apply',
  ];

  for (const phrase of REQUIRED_SAFETY_PHRASES) {
    it(`states: "${phrase}"`, () => {
      expect(normalizedSkill()).toContain(phrase);
    });
  }

  it('explicitly forbids calling a PR "safe to merge" and prefers "merge by hand"', () => {
    const s = normalizedSkill();
    // The guardrail rule must be stated verbatim, and the safe behaviour reinforced.
    expect(s).toContain('never tell the user a pr is safe to merge');
    expect(s).toContain('merge by hand');
  });

  it('forbids skipping the verifier / tests and presenting AI opinion as authority', () => {
    const s = normalizedSkill();
    expect(s).toContain('bypass the verifier');
    expect(s).toMatch(/skip tests|skip the slow checks|skip-checks/);
    expect(s).toContain('advisory'); // AI reviewer described as advisory, not authority
  });
});

describe('claude code skill — documents the key commands', () => {
  const REQUIRED_COMMANDS = [
    'github triage',
    'github run-issue',
    'github pr review',
    'watch',
    'status',
    'inspect',
  ];

  for (const cmd of REQUIRED_COMMANDS) {
    it(`documents: ${cmd}`, () => {
      expect(normalizedSkill()).toContain(cmd);
    });
  }

  it('documents all four PR-review verdicts', () => {
    const raw = readFileSync(skillPath, 'utf8');
    for (const verdict of ['SAFE TO REVIEW', 'NEEDS HUMAN DEV REVIEW', 'DO NOT MERGE', 'BLOCKED']) {
      expect(raw).toContain(verdict);
    }
  });

  it('keeps the safe confirmation tier (read-only commands need no confirmation)', () => {
    const s = normalizedSkill();
    expect(s).toContain('no confirmation needed');
    // run-issue must be flagged as execution, not a read-only preview.
    expect(s).toMatch(/run-issue[^\n]*(execute|autonomous|starts)/);
  });
});

describe('claude code skill — docs are wired in', () => {
  it('docs/claude-code-skill.md exists and the README links it', () => {
    expect(existsSync(join(repoRoot, 'docs', 'claude-code-skill.md'))).toBe(true);
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('Using the Claude Code skill');
    expect(readme).toContain('docs/claude-code-skill.md');
  });
});
