/**
 * Non-technical PR review report — hermetic tests.
 *
 * Proves the evidence-first review pipeline:
 *   - report generation from the objective event log (no agent claims),
 *   - the plain-English fields a non-technical owner relies on,
 *   - risk classification + manual-checklist generation,
 *   - the verifier-is-final-authority precedence (verifier pass → safe-to-review;
 *     verifier fail → do-not-merge; reviewer "pass" can NEVER override a verifier
 *     fail; secrets/forbidden paths → BLOCKED),
 *   - screenshot/browser artifact references,
 *   - secret redaction in the rendered report,
 *   - the draft-PR body's human-review section,
 *   - schema validation for the reviewer's product-owner summary,
 *   - PR comment posting is read-only by default (dry-run spawns no gh; apply posts).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { project, type RunSnapshot } from '../../src/events/projection.js';
import type { AgentLoopEvent } from '../../src/events/types.js';
import { PlanSchema, ReviewVerdictSchema, ProductOwnerSummarySchema, type Plan } from '../../src/domain/schemas.js';
import {
  buildPrReview,
  decidePrVerdict,
  renderPrReviewMarkdown,
  renderHumanReviewSection,
  groupFiles,
  extractEvidence,
  type PrEvidence,
} from '../../src/github/pr-review.js';
import { Redactor } from '../../src/security/redact.js';
import { GhClient } from '../../src/github/client.js';
import { ProcessManager } from '../../src/process/manager.js';

// --- builders ----------------------------------------------------------------

let seq = 0;
function ev(type: AgentLoopEvent['type'], payload: Record<string, unknown> = {}, sliceId?: string): AgentLoopEvent {
  return {
    schemaVersion: 1,
    eventId: `e${seq}`,
    seq: seq++,
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    runId: 'run-test',
    sliceId: sliceId ?? null,
    attemptId: 'a1',
    correlationId: null,
    source: 'orchestrator',
    type,
    payload,
  };
}

function mkPlan(over: { risk?: 'low' | 'medium' | 'high'; criteria?: string[] } = {}): Plan {
  return PlanSchema.parse({
    planId: 'plan-1',
    createdAt: new Date(1_700_000_000_000).toISOString(),
    goal: 'Add ticket search by customer name',
    repository: { root: '/tmp/x' },
    source: { kind: 'issue', ref: '#11' },
    verification: [{ id: 'test', category: 'test', command: 'npm test' }],
    slices: [
      {
        id: 'S-001',
        title: 'Add ticket search by customer name',
        description: 'Search tickets by customer name.',
        acceptanceCriteria: over.criteria ?? ['User can search tickets by customer name', 'Empty search shows all tickets'],
        allowedPaths: ['src/**'],
        requiredChecks: ['test'],
        risk: over.risk ?? 'low',
      },
    ],
  });
}

/** A clean, COMPLETED, low-risk run with a passing reviewer. */
function completedRunEvents(opts: { reviewer?: 'pass' | 'changes_requested' | 'blocked' } = {}): AgentLoopEvent[] {
  seq = 0;
  const out: AgentLoopEvent[] = [
    ev('PLAN_CREATED', { planId: 'plan-1', goal: 'Add ticket search by customer name', branch: 'agent/s-001', totalSlices: 1, sliceIds: ['S-001'], sliceTitles: { 'S-001': 'Add ticket search by customer name' } }),
    ev('RUN_STARTED', { branch: 'agent/s-001' }),
    ev('SLICE_READY', { title: 'Add ticket search by customer name' }, 'S-001'),
    ev('SLICE_STARTED', {}, 'S-001'),
    ev('PROVIDER_SELECTED', { role: 'worker', provider: 'fake' }, 'S-001'),
    ev('FILE_CHANGED', { files: ['src/search.ts', 'src/search.test.ts'] }, 'S-001'),
    ev('VERIFICATION_STARTED', {}, 'S-001'),
    ev('CHECK_FINISHED', { checkId: 'scope', ok: true }, 'S-001'),
    ev('CHECK_FINISHED', { checkId: 'secrets', ok: true }, 'S-001'),
    ev('CHECK_FINISHED', { checkId: 'structural', ok: true }, 'S-001'),
    ev('CHECK_FINISHED', { checkId: 'test-weakening', ok: true }, 'S-001'),
    ev('CHECK_FINISHED', { checkId: 'merge-conflict', ok: true }, 'S-001'),
    ev('CHECK_FINISHED', { checkId: 'diff-size', ok: true }, 'S-001'),
    ev('CHECK_FINISHED', { checkId: 'test', ok: true }, 'S-001'),
    ev('VERIFICATION_PASSED', { addedLines: 20, files: 2 }, 'S-001'),
  ];
  if (opts.reviewer) {
    out.push(
      ev('REVIEW_FINISHED', {
        provider: 'fake',
        verdict: opts.reviewer,
        malformed: false,
        findings: opts.reviewer === 'pass' ? 0 : 1,
        findingsDetail: opts.reviewer === 'pass' ? [] : [{ severity: 'high', file: 'src/search.ts', description: 'edge case', requiredAction: 'handle empty input' }],
        productOwnerSummary: { whatChanged: 'Adds a search box to the ticket list.', matchesIntent: 'yes', whatToManuallyTest: ['Type a customer name and confirm results filter.'], riskExplanation: 'Low — read-only filter.', mergeRecommendation: 'merge_after_check' },
      }, 'S-001'),
    );
  }
  out.push(
    ev('COMMIT_CREATED', { sha: 'abc1234567', message: 'S-001 Add ticket search', files: ['src/search.ts', 'src/search.test.ts'] }, 'S-001'),
    ev('SLICE_COMPLETED', { sha: 'abc1234567', summary: 'done' }, 'S-001'),
    ev('RUN_COMPLETED', {}),
  );
  return out;
}

// --- pure verdict precedence (verifier is the authority) ---------------------

function baseEvidence(over: Partial<PrEvidence> = {}): PrEvidence {
  return {
    hasLocalRun: true,
    runId: 'r',
    runState: 'COMPLETED',
    goal: 'g',
    branch: 'b',
    totalSlices: 1,
    verifiedCompleted: 1,
    slices: [{ id: 'S-001', title: 't', state: 'COMPLETED', risk: 'low', acceptanceCriteria: ['does a thing'] }],
    checks: [{ id: 'test', label: 'Tests', ok: true }],
    skippedChecks: [],
    security: { secrets: true, forbiddenPaths: true, protectedFiles: true, testIntegrity: true, mergeMarkers: true, lockfileChanged: false },
    changedFiles: ['src/a.ts'],
    commits: [{ sha: 'deadbeef', message: 'S-001 x' }],
    assumptions: [],
    maxRisk: 'low',
    costUsd: 0,
    tokens: 0,
    branchMismatch: false,
    ...over,
  };
}

describe('decidePrVerdict — verifier is the final authority', () => {
  it('verifier pass + low risk + reviewer pass → SAFE TO REVIEW', () => {
    const d = decidePrVerdict(baseEvidence({ review: { ran: true, verdict: 'pass', malformed: false, totalFindings: 0, criticalOrHigh: 0, findings: [], providers: ['fake'] } }));
    expect(d.verdict).toBe('SAFE TO REVIEW');
    expect(d.recommendation.toLowerCase()).toContain('merge after');
  });

  it('verifier FAIL (incomplete run) → DO NOT MERGE', () => {
    const d = decidePrVerdict(baseEvidence({ runState: 'FAILED', verifiedCompleted: 0, blocker: { reason: 'required check test failed', hard: false } }));
    expect(d.verdict).toBe('DO NOT MERGE');
    expect(d.recommendation.toLowerCase()).toContain('do not merge');
  });

  it('reviewer says PASS but verifier FAILED → still DO NOT MERGE (no override)', () => {
    const d = decidePrVerdict(
      baseEvidence({
        runState: 'FAILED',
        verifiedCompleted: 0,
        blocker: { reason: 'required check test failed', hard: false },
        review: { ran: true, verdict: 'pass', malformed: false, totalFindings: 0, criticalOrHigh: 0, findings: [], providers: ['fake'] },
      }),
    );
    expect(d.verdict).toBe('DO NOT MERGE');
  });

  it('secret detected → BLOCKED (strongest negative)', () => {
    const d = decidePrVerdict(baseEvidence({ runState: 'FAILED', verifiedCompleted: 0, security: { secrets: false, forbiddenPaths: true, protectedFiles: true, testIntegrity: true, mergeMarkers: true, lockfileChanged: false }, blocker: { reason: 'potential secret in diff', hard: true } }));
    expect(d.verdict).toBe('BLOCKED');
    expect(d.reasons.join(' ')).toMatch(/secret/i);
  });

  it('forbidden path touched → BLOCKED', () => {
    const d = decidePrVerdict(baseEvidence({ runState: 'FAILED', verifiedCompleted: 0, security: { secrets: true, forbiddenPaths: false, protectedFiles: true, testIntegrity: true, mergeMarkers: true, lockfileChanged: false }, blocker: { reason: 'modified forbidden paths', hard: true } }));
    expect(d.verdict).toBe('BLOCKED');
    expect(d.reasons.join(' ')).toMatch(/protected|forbidden/i);
  });

  it('reviewer BLOCKED but verifier clean → DO NOT MERGE (human must adjudicate)', () => {
    const d = decidePrVerdict(baseEvidence({ review: { ran: true, verdict: 'blocked', malformed: false, totalFindings: 1, criticalOrHigh: 1, findings: [], providers: ['fake'] } }));
    expect(d.verdict).toBe('DO NOT MERGE');
  });

  it('high-risk change, all checks clean → NEEDS HUMAN DEV REVIEW', () => {
    const d = decidePrVerdict(baseEvidence({ maxRisk: 'high', slices: [{ id: 'S-001', title: 't', state: 'COMPLETED', risk: 'high', acceptanceCriteria: ['x'] }] }));
    expect(d.verdict).toBe('NEEDS HUMAN DEV REVIEW');
    expect(d.riskLevel).toBe('High');
  });

  it('required browser check failed → BLOCKED', () => {
    const d = decidePrVerdict(baseEvidence({ browser: { ran: true, ok: false, required: true, engine: 'cdp', routes: 1, artifacts: [] } }));
    expect(d.verdict).toBe('BLOCKED');
  });

  it('advisory browser check failed → NEEDS HUMAN DEV REVIEW', () => {
    const d = decidePrVerdict(baseEvidence({ browser: { ran: true, ok: false, required: false, engine: 'cdp', routes: 1, artifacts: [] } }));
    expect(d.verdict).toBe('NEEDS HUMAN DEV REVIEW');
  });

  it('no local run record → never SAFE TO REVIEW', () => {
    const d = decidePrVerdict(baseEvidence({ hasLocalRun: false, runState: 'CREATED', verifiedCompleted: 0, totalSlices: 0 }));
    expect(d.verdict).not.toBe('SAFE TO REVIEW');
  });

  // --- adversarial-audit hardening regressions ---
  it('a safety scan with NO evidence it ran (undefined) → never SAFE TO REVIEW', () => {
    // e.g. detectSecrets disabled in config → no secrets event → must NOT be shown as pass.
    const d = decidePrVerdict(baseEvidence({ security: { secrets: undefined, forbiddenPaths: true, protectedFiles: true, testIntegrity: true, mergeMarkers: true, lockfileChanged: false } }));
    expect(d.verdict).toBe('NEEDS HUMAN DEV REVIEW');
    expect(d.concerns.join(' ')).toMatch(/no evidence it ran|disabled/i);
  });

  it('a SKIPPED check (allowedCommands) → never SAFE TO REVIEW', () => {
    const d = decidePrVerdict(baseEvidence({ skippedChecks: ['test'], checks: [{ id: 'test', label: 'Tests', ok: undefined, skipped: true }] }));
    expect(d.verdict).toBe('NEEDS HUMAN DEV REVIEW');
    expect(d.concerns.join(' ')).toMatch(/skipped/i);
  });

  it('PR branch does not match the local run → never SAFE TO REVIEW', () => {
    const d = decidePrVerdict(baseEvidence({ branchMismatch: true }));
    expect(d.verdict).toBe('NEEDS HUMAN DEV REVIEW');
    expect(d.concerns.join(' ')).toMatch(/does not match this PR/i);
  });

  it('UI files changed but no browser check ran → flagged for review', () => {
    const d = decidePrVerdict(baseEvidence({ changedFiles: ['src/App.tsx'] }));
    expect(d.verdict).toBe('NEEDS HUMAN DEV REVIEW');
    expect(d.concerns.join(' ')).toMatch(/no browser\/UI check ran/i);
  });
});

// --- report generation from the event log ------------------------------------

describe('buildPrReview / renderPrReviewMarkdown', () => {
  it('produces a SAFE TO REVIEW report with all plain-English sections', () => {
    const events = completedRunEvents({ reviewer: 'pass' });
    const snap = project(events);
    const report = buildPrReview({ events, snapshot: snap, plan: mkPlan(), sourceIssue: 11 });
    expect(report.verdict).toBe('SAFE TO REVIEW');
    expect(report.generatedFrom).toBe('local-run');

    const md = renderPrReviewMarkdown(report);
    // The non-technical fields a product owner depends on.
    expect(md).toContain('SAFE TO REVIEW');
    expect(md).toContain('## Plain-English summary');
    expect(md).toContain('## What changed');
    expect(md).toContain('## Why it changed');
    expect(md).toContain('## Checks');
    expect(md).toContain('## Security & safety');
    expect(md).toContain('## What you should manually check');
    expect(md).toContain('## Files changed');
    expect(md).toContain('Risk level:');
    expect(md).toContain('Recommendation:');
    // Never overclaims: still tells the human they decide + nothing was merged.
    expect(md).toMatch(/No code was merged|never merges/i);
  });

  it('manual checklist is generated from the acceptance criteria', () => {
    const events = completedRunEvents({ reviewer: 'pass' });
    const report = buildPrReview({ events, snapshot: project(events), plan: mkPlan(), sourceIssue: 11 });
    expect(report.manualChecks.some((c) => c.includes('search tickets by customer name'))).toBe(true);
    expect(report.manualChecks.some((c) => c.includes('Empty search shows all tickets'))).toBe(true);
  });

  it('classifies a high-risk change and routes it to NEEDS HUMAN DEV REVIEW', () => {
    const events = completedRunEvents({ reviewer: 'pass' });
    const report = buildPrReview({ events, snapshot: project(events), plan: mkPlan({ risk: 'high' }), sourceIssue: 11 });
    expect(report.riskLevel).toBe('High');
    expect(report.verdict).toBe('NEEDS HUMAN DEV REVIEW');
  });

  it('a verifier secret-block run renders a BLOCKED / do-not-merge report', () => {
    seq = 0;
    const events: AgentLoopEvent[] = [
      ev('PLAN_CREATED', { planId: 'plan-1', goal: 'g', branch: 'b', totalSlices: 1, sliceIds: ['S-001'], sliceTitles: { 'S-001': 's' } }),
      ev('RUN_STARTED', { branch: 'b' }),
      ev('SLICE_STARTED', {}, 'S-001'),
      ev('FILE_CHANGED', { files: ['src/cfg.ts'] }, 'S-001'),
      ev('CHECK_FINISHED', { checkId: 'secrets', ok: false }, 'S-001'),
      ev('VERIFICATION_FAILED', { reason: 'potential secret in diff' }, 'S-001'),
      ev('SLICE_BLOCKED', { reason: 'potential secret in diff' }, 'S-001'),
      ev('RUN_FAILED', {}),
    ];
    const report = buildPrReview({ events, snapshot: project(events), plan: mkPlan() });
    expect(report.verdict).toBe('BLOCKED');
    const md = renderPrReviewMarkdown(report);
    expect(md).toContain('Do not merge');
    expect(md).toMatch(/secret/i);
  });

  it('references browser/screenshot artifacts in the report and the manual checklist', () => {
    seq = 0;
    const events = completedRunEvents({ reviewer: 'pass' });
    // add a browser-verification event
    events.splice(events.length - 2, 0, ev('BROWSER_VERIFICATION_FINISHED', { ok: true, ran: true, engine: 'cdp', summary: 'ok', routes: 1, required: false }, 'S-001'));
    const report = buildPrReview({
      events,
      snapshot: project(events),
      plan: mkPlan(),
      sourceIssue: 11,
      browserArtifacts: ['.agent-loop/artifacts/ui-smoke/S-001__root.png'],
    });
    const md = renderPrReviewMarkdown(report);
    expect(md).toContain('S-001__root.png');
    expect(md).toContain('## Screenshots & browser evidence');
    expect(report.manualChecks.some((c) => c.includes('S-001__root.png'))).toBe(true);
  });
});

// --- adversarial-audit: no overclaim in extraction/rendering -----------------

describe('extraction never overclaims a check that did not actually run', () => {
  it('a SKIPPED command check (allowedCommands) is reported as not-run, never PASS', () => {
    seq = 0;
    const events: AgentLoopEvent[] = [
      ev('PLAN_CREATED', { planId: 'plan-1', goal: 'g', branch: 'b', totalSlices: 1, sliceIds: ['S-001'], sliceTitles: { 'S-001': 's' } }),
      ev('RUN_STARTED', { branch: 'b' }, undefined),
      ev('SLICE_STARTED', {}, 'S-001'),
      ev('FILE_CHANGED', { files: ['src/a.ts'] }, 'S-001'),
      ev('CHECK_FINISHED', { checkId: 'scope', ok: true }, 'S-001'),
      ev('CHECK_FINISHED', { checkId: 'secrets', ok: true }, 'S-001'),
      // verifier records a skipped check with ok=true + a "skipped …" summary:
      ev('CHECK_FINISHED', { checkId: 'test', ok: true, summary: 'skipped (not in allowedCommands)' }, 'S-001'),
      ev('COMMIT_CREATED', { sha: 'abc1234567', message: 'S-001 x', files: ['src/a.ts'] }, 'S-001'),
      ev('SLICE_COMPLETED', { sha: 'abc1234567' }, 'S-001'),
      ev('RUN_COMPLETED', {}),
    ];
    const e = extractEvidence({ events, snapshot: project(events), plan: mkPlan() });
    expect(e.skippedChecks).toContain('test');
    const testRow = e.checks.find((c) => c.id === 'test');
    expect(testRow?.skipped).toBe(true);
    expect(testRow?.ok).toBeUndefined(); // NOT true → never rendered as PASS
    const report = buildPrReview({ events, snapshot: project(events), plan: mkPlan() });
    expect(report.verdict).toBe('NEEDS HUMAN DEV REVIEW');
  });

  it('a disabled secrets scan (no secrets event) is reported as NOT CHECKED, never PASS', () => {
    seq = 0;
    const events: AgentLoopEvent[] = [
      ev('PLAN_CREATED', { planId: 'plan-1', goal: 'g', branch: 'b', totalSlices: 1, sliceIds: ['S-001'], sliceTitles: { 'S-001': 's' } }),
      ev('RUN_STARTED', { branch: 'b' }, undefined),
      ev('SLICE_STARTED', {}, 'S-001'),
      ev('FILE_CHANGED', { files: ['src/a.ts'] }, 'S-001'),
      ev('CHECK_FINISHED', { checkId: 'scope', ok: true }, 'S-001'),
      ev('CHECK_FINISHED', { checkId: 'structural', ok: true }, 'S-001'),
      // NO 'secrets' CHECK_FINISHED — detectSecrets was disabled in config.
      ev('CHECK_FINISHED', { checkId: 'test', ok: true }, 'S-001'),
      ev('COMMIT_CREATED', { sha: 'abc1234567', message: 'S-001 x', files: ['src/a.ts'] }, 'S-001'),
      ev('SLICE_COMPLETED', { sha: 'abc1234567' }, 'S-001'),
      ev('RUN_COMPLETED', {}),
    ];
    const e = extractEvidence({ events, snapshot: project(events), plan: mkPlan() });
    expect(e.security.secrets).toBeUndefined(); // not assumed-pass
    const md = renderPrReviewMarkdown(buildPrReview({ events, snapshot: project(events), plan: mkPlan() }));
    expect(md).toContain('NOT CHECKED');
    expect(buildPrReview({ events, snapshot: project(events), plan: mkPlan() }).verdict).toBe('NEEDS HUMAN DEV REVIEW');
  });
});

// --- secret redaction in the rendered report ---------------------------------

describe('secret redaction in the PR review report', () => {
  it('a known secret value in a reviewer finding is masked by the redactor', () => {
    const secret = 'ghp_' + 'Z'.repeat(36);
    const evidence = baseEvidence({
      review: { ran: true, verdict: 'changes_requested', malformed: false, totalFindings: 1, criticalOrHigh: 1, findings: [{ severity: 'high', description: `leaked token ${secret} in code` }], providers: ['fake'] },
    });
    const report = { ...decidePrVerdict(evidence), manualChecks: [], evidence, generatedFrom: 'local-run' as const };
    const raw = renderPrReviewMarkdown(report);
    expect(raw).toContain(secret); // present before redaction
    const redacted = new Redactor([secret]).redact(raw);
    expect(redacted).not.toContain(secret); // masked after redaction (the CLI applies this)
  });
});

// --- file grouping -----------------------------------------------------------

describe('groupFiles — user-friendly categories', () => {
  it('groups by human-meaningful category', () => {
    const g = groupFiles(['src/app.ts', 'src/Button.tsx', 'src/app.test.ts', 'README.md', 'package.json']);
    expect(g['App logic']).toContain('src/app.ts');
    expect(g['User interface']).toContain('src/Button.tsx');
    expect(g['Tests']).toContain('src/app.test.ts');
    expect(g['Documentation']).toContain('README.md');
    expect(g['Configuration']).toContain('package.json');
  });
});

// --- draft-PR body human-review section --------------------------------------

describe('renderHumanReviewSection (draft-PR body)', () => {
  it('includes the verdict, manual checks, and the human-review/no-auto-merge banner', () => {
    const events = completedRunEvents({ reviewer: 'pass' });
    const snap: RunSnapshot = project(events);
    const section = renderHumanReviewSection(snap, { plan: mkPlan(), sourceIssue: 11 });
    expect(section).toContain('Plain-English review');
    expect(section).toMatch(/No auto-merge was performed/i);
    expect(section).toMatch(/Human review is required/i);
    expect(section).toContain('Verdict:');
    expect(section).toContain('You should manually check');
  });

  it('does not crash on an empty snapshot (used by existing PR-body tests)', () => {
    const section = renderHumanReviewSection(project([]));
    expect(section).toContain('Plain-English review');
    expect(section).toMatch(/Human review is required/i);
  });
});

// --- reviewer product-owner summary schema -----------------------------------

describe('reviewer product-owner summary schema', () => {
  it('accepts a well-formed product-owner summary and rejects bad merge recommendations', () => {
    const ok = ReviewVerdictSchema.safeParse({
      verdict: 'pass',
      findings: [],
      productOwnerSummary: { whatChanged: 'Adds search', matchesIntent: 'yes', whatToManuallyTest: ['search a name'], riskExplanation: 'low', mergeRecommendation: 'merge_after_check' },
    });
    expect(ok.success).toBe(true);

    const bad = ProductOwnerSummarySchema.safeParse({ whatChanged: 'x', matchesIntent: 'maybe', mergeRecommendation: 'ship_it' });
    expect(bad.success).toBe(false);
  });

  it('still validates a verdict with no product-owner layer (back-compat)', () => {
    const ok = ReviewVerdictSchema.safeParse({ verdict: 'pass', findings: [] });
    expect(ok.success).toBe(true);
  });
});

// --- extractEvidence sanity --------------------------------------------------

describe('extractEvidence — derives from the event log, not agent claims', () => {
  it('reports the committed files, commits, and a passing reviewer', () => {
    const events = completedRunEvents({ reviewer: 'pass' });
    const e = extractEvidence({ events, snapshot: project(events), plan: mkPlan(), sourceIssue: 11 });
    expect(e.changedFiles).toEqual(['src/search.test.ts', 'src/search.ts']);
    expect(e.commits.map((c) => c.sha)).toContain('abc1234567');
    expect(e.review?.verdict).toBe('pass');
    expect(e.review?.productOwner?.mergeRecommendation).toBe('merge_after_check');
    expect(e.security.secrets).toBe(true);
  });

  it('z is importable (schema lib present)', () => {
    expect(typeof z.object).toBe('function');
  });
});

// --- GhClient: PR read + comment (read-only by default) -----------------------

const pm = new ProcessManager();
const stubDirs: string[] = [];
let savedPath: string | undefined;

function ghStub(): { dir: string; log: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'al-prr-gh-'));
  stubDirs.push(dir);
  const logFile = join(dir, 'gh.log');
  const file = join(dir, 'gh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf '%s :: ' "$1 $2" >> "${logFile}"`,
      `printf '%s' "$*" | tr '\\n\\r' '  ' >> "${logFile}"`,
      `printf '\\n' >> "${logFile}"`,
      'case "$1 $2" in',
      `  "pr view") printf '%s\\n' '{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":true,"headRefName":"agent/s-001","baseRefName":"main","files":[{"path":"src/search.ts"},{"path":"src/search.test.ts"}],"commits":[{"oid":"abc"}]}' ;;`,
      `  "pr comment") printf '%s\\n' "https://github.com/o/r/pull/7#comment-1" ;;`,
      `  *) printf '%s\\n' "{}" ;;`,
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
  return { dir, log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

beforeEach(() => {
  savedPath = process.env['PATH'];
});
afterEach(() => {
  process.env['PATH'] = savedPath;
});
afterAll(() => {
  for (const d of stubDirs) rmSync(d, { recursive: true, force: true });
});

describe('GhClient.viewPr / commentPr', () => {
  it('viewPr parses PR metadata read-only', async () => {
    const gh = ghStub();
    process.env['PATH'] = `${gh.dir}:${savedPath}`;
    const client = new GhClient(process.cwd(), { dryRun: false, pm });
    const pr = await client.viewPr('o/r', 7);
    expect(pr.number).toBe(7);
    expect(pr.headRefName).toBe('agent/s-001');
    expect(pr.files).toEqual(['src/search.ts', 'src/search.test.ts']);
    expect(pr.commits).toBe(1);
  });

  it('commentPr in DRY-RUN never spawns gh (read-only default)', async () => {
    const gh = ghStub();
    process.env['PATH'] = `${gh.dir}:${savedPath}`;
    let wrote: string | undefined;
    const client = new GhClient(process.cwd(), { dryRun: true, pm, onWrite: (w) => (wrote = w.action) });
    await client.commentPr('o/r', 7, 'hello body');
    expect(wrote).toBe('pr-comment'); // intent reported
    expect(gh.log().some((l) => l.startsWith('pr comment'))).toBe(false); // but nothing posted
  });

  it('commentPr with apply posts the report body via gh', async () => {
    const gh = ghStub();
    process.env['PATH'] = `${gh.dir}:${savedPath}`;
    const client = new GhClient(process.cwd(), { dryRun: false, pm });
    await client.commentPr('o/r', 7, 'PLAIN ENGLISH REVIEW BODY');
    const call = gh.log().find((l) => l.startsWith('pr comment'));
    expect(call).toBeTruthy();
    expect(call).toContain('PLAIN ENGLISH REVIEW BODY');
  });
});
