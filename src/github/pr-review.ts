/**
 * Non-technical PR review report.
 *
 * This module turns the OBJECTIVE run record (the append-only event log + the
 * validated plan + the projected snapshot) into a plain-English review a
 * non-technical product owner can trust. It is evidence-first: every line is
 * derived from what was deterministically observed (verifier verdict, every
 * safety scan, the project's checks, the AI reviewer's findings, browser
 * results, changed files, commits) — never from an agent's self-description.
 *
 * Authority order is strict and enforced in `decidePrVerdict`:
 *   deterministic verifier  >  AI reviewer  >  everything else.
 * A failed deterministic check can NEVER be upgraded by an approving AI reviewer.
 * The report recommends; it never merges, deploys, or closes anything.
 */
import type { AgentLoopEvent } from '../events/types.js';
import type { RunSnapshot } from '../events/projection.js';
import type { Plan, Risk, ReviewFinding, ProductOwnerSummary } from '../domain/schemas.js';
import type { RunState, SliceState } from '../domain/states.js';

export type PrVerdict = 'SAFE TO REVIEW' | 'NEEDS HUMAN DEV REVIEW' | 'DO NOT MERGE' | 'BLOCKED';
export type RiskLevel = 'Low' | 'Medium' | 'High';

/** PR metadata fetched from `gh` (optional enrichment; never the source of truth). */
export interface PrMeta {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName?: string;
  files: string[];
  commits: number;
}

export interface CheckRow {
  id: string;
  label: string;
  ok: boolean | undefined;
  /** True when the verifier SKIPPED this check (e.g. not in allowedCommands) — it did
   * NOT actually run, so it must never be reported as a pass. */
  skipped?: boolean;
}

/**
 * Tri-state safety guards. `true` = ran and clean; `false` = ran and failed (or a
 * blocker named it); `undefined` = NO evidence it ran (e.g. the scan was disabled in
 * config, so it emitted no event). `undefined` must NEVER be rendered as a pass — that
 * is exactly the overclaim a non-technical owner must not be shown.
 */
export interface SecurityEvidence {
  secrets: boolean | undefined;
  forbiddenPaths: boolean | undefined;
  protectedFiles: boolean | undefined;
  testIntegrity: boolean | undefined;
  mergeMarkers: boolean | undefined;
  /** A dependency lockfile was changed (informational, not a failure). */
  lockfileChanged: boolean;
}

export interface ReviewEvidence {
  ran: boolean;
  verdict: 'pass' | 'changes_requested' | 'blocked';
  malformed: boolean;
  totalFindings: number;
  criticalOrHigh: number;
  findings: ReviewFinding[];
  productOwner?: ProductOwnerSummary;
  providers: string[];
}

export interface BrowserEvidence {
  ran: boolean;
  ok: boolean;
  required: boolean;
  engine: string;
  routes: number;
  artifacts: string[];
}

export interface SliceEvidence {
  id: string;
  title: string;
  state: SliceState;
  risk?: Risk;
  acceptanceCriteria: string[];
  commit?: string;
}

export interface PrEvidence {
  hasLocalRun: boolean;
  runId: string;
  runState: RunState;
  goal: string;
  branch: string;
  sourceIssue?: number;
  totalSlices: number;
  verifiedCompleted: number;
  slices: SliceEvidence[];
  checks: CheckRow[];
  /** Configured checks that the verifier SKIPPED (e.g. not in allowedCommands) — they
   * did not actually run and must not be counted as passing. */
  skippedChecks: string[];
  security: SecurityEvidence;
  review?: ReviewEvidence;
  browser?: BrowserEvidence;
  changedFiles: string[];
  commits: Array<{ sha: string; message: string }>;
  blocker?: { reason: string; hard: boolean; details?: string };
  assumptions: string[];
  maxRisk: Risk;
  costUsd: number;
  tokens: number;
  pr?: PrMeta;
  /** The local run evidence does NOT correspond to the PR (head branch mismatch), so it
   * cannot be trusted to describe this PR's changes. */
  branchMismatch: boolean;
}

export interface PrReviewReport {
  verdict: PrVerdict;
  riskLevel: RiskLevel;
  recommendation: string;
  reasons: string[];
  concerns: string[];
  manualChecks: string[];
  evidence: PrEvidence;
  generatedFrom: 'local-run' | 'pr-metadata-only';
}

// --- evidence extraction -----------------------------------------------------

/** Internal verifier safety scans (ids emitted by src/verify/verifier.ts). */
const SECURITY_CHECK_IDS = new Set(['scope', 'structural', 'secrets', 'diff-size', 'test-weakening', 'merge-conflict', 'lockfile', 'changes']);
const HARD_BLOCK_RE = /secret|forbidden|\.git|git-internal|traversal|symlink|denied command/i;

function str(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === 'string' ? v : undefined;
}
function num(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === 'number' ? v : undefined;
}

export interface ExtractInput {
  events: readonly AgentLoopEvent[];
  snapshot: RunSnapshot;
  plan?: Plan | undefined;
  sourceIssue?: number | undefined;
  browserArtifacts?: string[];
  pr?: PrMeta | undefined;
  /** Set when the PR's head branch does not match the local run branch — the local
   * evidence may belong to a different change and must not be trusted as SAFE. */
  branchMismatch?: boolean | undefined;
}

/** Build the full objective evidence pack from a local run's event log. */
export function extractEvidence(input: ExtractInput): PrEvidence {
  const { events, snapshot: snap, plan } = input;
  const planSlices = new Map((plan?.slices ?? []).map((s) => [s.id, s]));

  // Last-wins per check id (a later attempt's result supersedes an earlier one, so a
  // check that failed then passed reflects the FINAL committed state — which is what a
  // merge decision needs). Earlier auto-recovered failures are intentionally not shown
  // as failures; the blocker/verifier failure surfaces any UNrecovered problem.
  const checkOk = new Map<string, boolean>();
  const checkSummary = new Map<string, string>();
  const commits: Array<{ sha: string; message: string }> = [];
  const committedFiles = new Set<string>();
  const reviewEvents: Array<Record<string, unknown>> = [];
  const browserEvents: Array<Record<string, unknown>> = [];
  let blockerReason: string | undefined;
  let blockerDetails: string | undefined;

  for (const ev of events) {
    const p = ev.payload;
    switch (ev.type) {
      case 'CHECK_FINISHED': {
        const id = str(p, 'checkId') ?? str(p, 'id');
        if (id) {
          checkOk.set(id, p['ok'] === true);
          const sum = str(p, 'summary');
          if (sum) checkSummary.set(id, sum);
        }
        break;
      }
      case 'COMMIT_CREATED': {
        const sha = str(p, 'sha');
        if (sha) commits.push({ sha, message: str(p, 'message') ?? '' });
        const files = p['files'];
        if (Array.isArray(files)) for (const f of files) if (typeof f === 'string') committedFiles.add(f);
        break;
      }
      case 'REVIEW_FINISHED':
        reviewEvents.push(p);
        break;
      case 'BROWSER_VERIFICATION_FINISHED':
        browserEvents.push(p);
        break;
      case 'SLICE_BLOCKED':
        blockerReason = str(p, 'reason') ?? blockerReason;
        blockerDetails = str(p, 'details') ?? blockerDetails;
        break;
      default:
        break;
    }
  }

  const security = extractSecurity(checkOk, blockerReason, false, snap.changedFiles);
  const checks = extractCommandChecks(checkOk, checkSummary, plan);
  const skippedChecks = checks.filter((c) => c.skipped).map((c) => c.id);
  const review = reviewEvents.length ? aggregateReview(reviewEvents) : undefined;
  const browser = browserEvents.length ? aggregateBrowser(browserEvents, input.browserArtifacts ?? []) : undefined;

  const slices: SliceEvidence[] = snap.sliceOrder.map((id) => {
    const sv = snap.slices[id];
    const ps = planSlices.get(id);
    return {
      id,
      title: sv?.title ?? ps?.title ?? id,
      state: (sv?.state ?? 'PENDING') as SliceState,
      ...(ps ? { risk: ps.risk } : {}),
      acceptanceCriteria: ps?.acceptanceCriteria ?? [],
      ...(sv?.lastCommit ? { commit: sv.lastCommit } : {}),
    };
  });

  const changedFiles = committedFiles.size > 0
    ? [...committedFiles].sort()
    : (snap.changedFiles.length ? [...snap.changedFiles].sort() : (input.pr?.files ?? []));

  const maxRisk = highestRisk((plan?.slices ?? []).map((s) => s.risk));
  const blocker = blockerReason
    ? { reason: blockerReason, hard: HARD_BLOCK_RE.test(blockerReason), ...(blockerDetails ? { details: blockerDetails } : {}) }
    : snap.blocker
      ? { reason: snap.blocker.reason, hard: HARD_BLOCK_RE.test(snap.blocker.reason) }
      : undefined;

  return {
    hasLocalRun: events.length > 0,
    runId: snap.runId,
    runState: snap.runState,
    goal: snap.goal || plan?.goal || '',
    branch: snap.branch || input.pr?.headRefName || '',
    ...(input.sourceIssue !== undefined ? { sourceIssue: input.sourceIssue } : {}),
    totalSlices: snap.totalSlices,
    verifiedCompleted: snap.verifiedCompleted,
    slices,
    checks,
    skippedChecks,
    security,
    ...(review ? { review } : {}),
    ...(browser ? { browser } : {}),
    changedFiles,
    commits,
    ...(blocker ? { blocker } : {}),
    assumptions: snap.assumptions,
    maxRisk,
    costUsd: snap.costUsd,
    tokens: snap.tokens,
    ...(input.pr ? { pr: input.pr } : {}),
    branchMismatch: input.branchMismatch === true,
  };
}

function extractSecurity(
  checkOk: Map<string, boolean>,
  blockerReason: string | undefined,
  assumePassOnMissing: boolean,
  changedFiles: string[] = [],
): SecurityEvidence {
  const blockedBy = (re: RegExp): boolean => blockerReason !== undefined && re.test(blockerReason);
  // Tri-state guard: a present CHECK_FINISHED event is authoritative; a blocker reason is
  // a hard fail; otherwise the scan left no evidence it ran. We only assume "clean on
  // missing" for the snapshot fallback (which structurally cannot carry safety-scan
  // events) — the event-based path reports `undefined` ("not checked") so a config that
  // DISABLED a scan (e.g. detectSecrets:false → no event) is never shown as a pass.
  const guard = (id: string, re: RegExp): boolean | undefined => {
    if (blockedBy(re)) return false;
    if (checkOk.has(id)) return checkOk.get(id)!;
    return assumePassOnMissing ? true : undefined;
  };
  return {
    secrets: guard('secrets', /secret/i),
    forbiddenPaths: guard('scope', /forbidden|out-of-scope|scope/i),
    protectedFiles: guard('structural', /\.git|git-internal|traversal|symlink/i),
    testIntegrity: guard('test-weakening', /weaken/i),
    mergeMarkers: guard('merge-conflict', /conflict/i),
    lockfileChanged: changedFiles.some((f) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock)$/.test(f)),
  };
}

function extractCommandChecks(checkOk: Map<string, boolean>, checkSummary: Map<string, string>, plan?: Plan): CheckRow[] {
  const rows: CheckRow[] = [];
  const planById = new Map((plan?.verification ?? []).map((c) => [c.id, c]));
  for (const [id, ok] of checkOk) {
    if (SECURITY_CHECK_IDS.has(id)) continue; // shown in the security panel
    const cat = planById.get(id)?.category;
    // A check the verifier SKIPPED (e.g. not in allowedCommands) is recorded with ok=true
    // and a "skipped …" summary — it did NOT run, so report it as not-run, never a pass.
    const skipped = /skip/i.test(checkSummary.get(id) ?? '');
    rows.push({ id, label: friendlyCheckLabel(id, cat), ok: skipped ? undefined : ok, ...(skipped ? { skipped: true } : {}) });
  }
  return rows;
}

function friendlyCheckLabel(id: string, category?: string): string {
  const c = category ?? '';
  if (c === 'test' || /test|spec|vitest|jest/i.test(id)) return 'Tests';
  if (c === 'build' || /build|compile|bundle/i.test(id)) return 'Build';
  if (c === 'typecheck' || /typecheck|tsc|types/i.test(id)) return 'Typecheck';
  if (c === 'lint' || /lint|eslint|format/i.test(id)) return 'Lint';
  return id;
}

function aggregateReview(evts: Array<Record<string, unknown>>): ReviewEvidence {
  let verdict: ReviewEvidence['verdict'] = 'pass';
  let malformed = false;
  const findings: ReviewFinding[] = [];
  const providers = new Set<string>();
  let productOwner: ProductOwnerSummary | undefined;
  for (const p of evts) {
    const v = str(p, 'verdict');
    if (v === 'blocked') verdict = 'blocked';
    else if (v === 'changes_requested' && verdict !== 'blocked') verdict = 'changes_requested';
    if (p['malformed'] === true) malformed = true;
    const prov = str(p, 'provider');
    if (prov) providers.add(prov);
    const detail = p['findingsDetail'];
    if (Array.isArray(detail)) for (const f of detail) if (f && typeof f === 'object') findings.push(f as ReviewFinding);
    const po = p['productOwnerSummary'];
    if (po && typeof po === 'object') productOwner = po as ProductOwnerSummary;
  }
  const criticalOrHigh = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
  return {
    ran: true,
    verdict,
    malformed,
    totalFindings: findings.length,
    criticalOrHigh,
    findings,
    ...(productOwner ? { productOwner } : {}),
    providers: [...providers],
  };
}

function aggregateBrowser(evts: Array<Record<string, unknown>>, artifacts: string[]): BrowserEvidence {
  let ran = false;
  let ok = true;
  let required = false;
  let engine = 'none';
  let routes = 0;
  for (const p of evts) {
    if (p['ran'] === true) ran = true;
    if (p['ran'] === true && p['ok'] !== true) ok = false;
    if (p['required'] === true) required = true;
    const e = str(p, 'engine');
    if (e && e !== 'none') engine = e;
    routes = Math.max(routes, num(p, 'routes') ?? 0);
  }
  return { ran, ok: ran ? ok : true, required, engine, routes, artifacts };
}

function highestRisk(risks: Risk[]): Risk {
  if (risks.includes('high')) return 'high';
  if (risks.includes('medium')) return 'medium';
  return 'low';
}

/** The safety guards as labelled, tri-state values (for verdict + rendering). */
function sec(e: PrEvidence): Array<{ label: string; value: boolean | undefined }> {
  return [
    { label: 'Secrets / credentials', value: e.security.secrets },
    { label: 'Forbidden / out-of-scope files', value: e.security.forbiddenPaths },
    { label: 'Protected locations (.git, symlinks)', value: e.security.protectedFiles },
    { label: 'Tests not weakened', value: e.security.testIntegrity },
    { label: 'No merge-conflict markers', value: e.security.mergeMarkers },
  ];
}

function hasUiFiles(files: string[]): boolean {
  return files.some((f) => /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/.test(f));
}

// --- verdict (authority order enforced here) ---------------------------------

export function decidePrVerdict(e: PrEvidence): { verdict: PrVerdict; riskLevel: RiskLevel; recommendation: string; reasons: string[]; concerns: string[] } {
  const reasons: string[] = [];
  const concerns: string[] = [];

  // A guard === false means it RAN and FAILED (strongest negative). A guard ===
  // undefined means there is NO evidence it ran (e.g. the scan was disabled in config)
  // — that is a gap, not a pass.
  const securityFail = sec(e).some((g) => g.value === false);
  const securityUnknown = sec(e).filter((g) => g.value === undefined);
  const verifierClean = e.runState === 'COMPLETED' && e.verifiedCompleted === e.totalSlices && e.totalSlices > 0 && !e.blocker;
  const requiredBrowserFailed = !!e.browser?.ran && !e.browser.ok && e.browser.required;

  // 1) Hard safety / hard verifier block — the strongest negative.
  if (securityFail || e.blocker?.hard || requiredBrowserFailed) {
    if (e.security.secrets === false) reasons.push('A potential secret/credential was detected in the changes — must not be merged.');
    if (e.security.forbiddenPaths === false) reasons.push('A protected/forbidden file (e.g. .env, secrets, production infra) was touched.');
    if (e.security.protectedFiles === false) reasons.push('A protected location (.git internals / symlink escape / path traversal) was touched.');
    if (e.security.testIntegrity === false) reasons.push('Existing tests appear to have been deleted or weakened.');
    if (e.security.mergeMarkers === false) reasons.push('Unresolved merge-conflict markers are present in the changes.');
    if (requiredBrowserFailed) reasons.push('A REQUIRED browser/UI check did not pass.');
    if (e.blocker?.hard && reasons.length === 0) reasons.push(`The run was hard-blocked: ${e.blocker.reason}`);
    return { verdict: 'BLOCKED', riskLevel: 'High', recommendation: 'Do not merge.', reasons, concerns };
  }

  // 2) The deterministic verifier did not produce a clean, complete result.
  if (!verifierClean) {
    if (e.blocker) reasons.push(`The automated checks stopped the work: ${e.blocker.reason}`);
    else if (e.runState !== 'COMPLETED') reasons.push(`The run did not finish cleanly (state: ${e.runState}).`);
    if (e.totalSlices > 0 && e.verifiedCompleted < e.totalSlices) {
      reasons.push(`Only ${e.verifiedCompleted} of ${e.totalSlices} planned pieces of work passed automatic verification.`);
    }
    if (!e.hasLocalRun) reasons.push('No local verification record was found, so automated checks cannot be confirmed.');
    return { verdict: 'DO NOT MERGE', riskLevel: 'High', recommendation: 'Do not merge. The work is incomplete or did not pass automatic checks.', reasons, concerns };
  }

  // --- The deterministic verifier is CLEAN below this line. ---
  // The AI reviewer is advisory: it can flag concerns or block, but it can never
  // turn a verifier failure into a pass (handled above).

  // 3) AI reviewer explicitly blocked (verifier passed → a human must adjudicate).
  if (e.review?.verdict === 'blocked') {
    reasons.push('The automated checks passed, but the AI code reviewer flagged a blocking concern that a human must resolve.');
    return { verdict: 'DO NOT MERGE', riskLevel: 'High', recommendation: 'Do not merge until a developer resolves the reviewer’s blocking concern.', reasons, concerns };
  }

  // 4) Verifier clean, but signals that warrant a developer's eyes.
  if (!e.hasLocalRun) concerns.push('No local verification record was found — automated checks could not be confirmed from this machine.');
  if (e.branchMismatch) concerns.push('The local run does not match this PR’s branch — the checks may describe a different change.');
  for (const g of securityUnknown) concerns.push(`The “${g.label}” safety scan has no evidence it ran (it may be disabled in config) — do not assume it passed.`);
  if (e.skippedChecks.length > 0) concerns.push(`Configured check(s) were skipped (not run): ${e.skippedChecks.join(', ')}.`);
  if (e.review?.verdict === 'changes_requested') concerns.push('The AI reviewer requested changes (advisory).');
  if (e.review && e.review.criticalOrHigh > 0) concerns.push(`The AI reviewer raised ${e.review.criticalOrHigh} higher-severity note(s).`);
  if (e.review?.malformed) concerns.push('The AI reviewer’s output could not be fully parsed (treated as an advisory pass).');
  if (e.browser?.ran && !e.browser.ok) concerns.push('An advisory browser/UI check did not fully pass (it does not block, but worth a look).');
  if (!e.browser?.ran && hasUiFiles(e.changedFiles)) concerns.push('User-interface files changed but no browser/UI check ran — open the screen and confirm it looks right.');
  if (e.maxRisk === 'high') concerns.push('This change touches areas marked HIGH risk.');
  if (e.security.lockfileChanged) concerns.push('A dependency lockfile changed — confirm the dependency change was intended.');
  if (e.assumptions.length > 0) concerns.push(`${e.assumptions.length} assumption(s) were recorded while building — confirm they hold.`);
  if (!e.review) concerns.push('No AI code review was run for this change (the deterministic checks still passed).');

  const riskLevel: RiskLevel = e.maxRisk === 'high' ? 'High' : e.maxRisk === 'medium' ? 'Medium' : 'Low';

  // A developer should look when there are real concerns, or the change is high-risk, or
  // there is no trustworthy local verification record, or a (advisory) browser check
  // actually failed, or a safety scan / configured check did not actually run.
  const advisoryBrowserFailed = !!e.browser?.ran && !e.browser.ok;
  const uiUnverified = !e.browser?.ran && hasUiFiles(e.changedFiles);
  const needsDev =
    e.maxRisk === 'high' ||
    !e.hasLocalRun ||
    e.branchMismatch ||
    securityUnknown.length > 0 ||
    e.skippedChecks.length > 0 ||
    e.review?.verdict === 'changes_requested' ||
    (e.review?.criticalOrHigh ?? 0) > 0 ||
    advisoryBrowserFailed ||
    uiUnverified;
  if (needsDev) {
    if (reasons.length === 0) reasons.push('Automatic checks passed, but this change has signals a developer should confirm before merge.');
    return { verdict: 'NEEDS HUMAN DEV REVIEW', riskLevel, recommendation: 'Ask a developer to review before merging.', reasons, concerns };
  }

  reasons.push('All automatic safety and quality checks passed and no blocking concerns were found.');
  return {
    verdict: 'SAFE TO REVIEW',
    riskLevel,
    recommendation: 'Safe for you to review. Merge after completing the manual checks below. (You still merge by hand — nothing is automatic.)',
    reasons,
    concerns,
  };
}

// --- manual checklist --------------------------------------------------------

export function buildManualChecks(e: PrEvidence): string[] {
  const out: string[] = [];
  const subject = e.sourceIssue ? `the change requested in issue #${e.sourceIssue}` : 'the change';
  out.push(`Open the app and use ${subject} the way a real user would — confirm it actually works.`);
  for (const s of e.slices) {
    if (s.acceptanceCriteria.length) for (const c of s.acceptanceCriteria) out.push(`Confirm: ${c}`);
    else if (s.state === 'COMPLETED') out.push(`Confirm “${s.title}” works as expected.`);
  }
  if (e.review?.productOwner?.whatToManuallyTest?.length) {
    for (const t of e.review.productOwner.whatToManuallyTest) out.push(t);
  }
  if (e.browser?.ran && e.browser.artifacts.length) {
    out.push(`Open the saved screenshot(s)/page snapshot(s) and confirm the screen looks correct: ${e.browser.artifacts.map(baseName).join(', ')}.`);
  }
  if (e.security.lockfileChanged) out.push('Confirm any dependency (package) changes were expected.');
  if (e.changedFiles.some((f) => /\.(env|pem|key)$/i.test(f))) out.push('Double-check no sensitive/config files were changed unexpectedly.');
  // Dedupe, keep order, cap to a readable length.
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x) ? false : (seen.add(x), true))).slice(0, 14);
}

// --- snapshot-only evidence (for the PR body, decoupled from the event log) --

/**
 * Build evidence from a projected snapshot alone (no raw events). Used by the
 * draft-PR body: it has the command checks, slices, blocker and progress, but not
 * the AI reviewer / browser detail (those live in the full `pr review` report).
 * A COMPLETED run only commits code that cleared every safety scan, so the safety
 * guards are reported clean for a completed run and conservatively from the
 * blocker reason otherwise.
 */
export function evidenceFromSnapshot(snap: RunSnapshot, opts: { plan?: Plan | undefined; sourceIssue?: number | undefined } = {}): PrEvidence {
  const planSlices = new Map((opts.plan?.slices ?? []).map((s) => [s.id, s]));
  const checks: CheckRow[] = snap.checks.map((c) => ({ id: c.id, label: friendlyCheckLabel(c.id, undefined), ok: c.state === 'passed' ? true : c.state === 'failed' ? false : undefined }));
  const blockerReason = snap.blocker?.reason;
  // Snapshot fallback only: the projection structurally cannot carry the safety-scan
  // events, so for a COMPLETED run we assume the scans that gate a commit passed. The
  // event-based path (the authoritative report and, via FIX-from-events, the PR body)
  // does NOT make this assumption.
  const security = extractSecurity(new Map(), blockerReason, snap.runState === 'COMPLETED', snap.changedFiles);
  const slices: SliceEvidence[] = snap.sliceOrder.map((id) => {
    const sv = snap.slices[id];
    const ps = planSlices.get(id);
    return {
      id,
      title: sv?.title ?? id,
      state: (sv?.state ?? 'PENDING') as SliceState,
      ...(ps ? { risk: ps.risk } : {}),
      acceptanceCriteria: ps?.acceptanceCriteria ?? [],
      ...(sv?.lastCommit ? { commit: sv.lastCommit } : {}),
    };
  });
  const blocker = snap.blocker ? { reason: snap.blocker.reason, hard: HARD_BLOCK_RE.test(snap.blocker.reason) } : undefined;
  return {
    hasLocalRun: true,
    runId: snap.runId,
    runState: snap.runState,
    goal: snap.goal || opts.plan?.goal || '',
    branch: snap.branch,
    ...(opts.sourceIssue !== undefined ? { sourceIssue: opts.sourceIssue } : {}),
    totalSlices: snap.totalSlices,
    verifiedCompleted: snap.verifiedCompleted,
    slices,
    checks,
    skippedChecks: [],
    security,
    changedFiles: [...snap.changedFiles].sort(),
    commits: snap.lastCommit ? [snap.lastCommit] : [],
    ...(blocker ? { blocker } : {}),
    assumptions: snap.assumptions,
    maxRisk: highestRisk((opts.plan?.slices ?? []).map((s) => s.risk)),
    costUsd: snap.costUsd,
    tokens: snap.tokens,
    branchMismatch: false,
  };
}

/** A concise, non-technical human-review block embedded in the draft-PR body. Built
 * from a snapshot (fallback). Prefer `renderHumanReviewFromEvidence` with the full event
 * log so the body's verdict/risk match the `pr review` report exactly. */
export function renderHumanReviewSection(snap: RunSnapshot, opts: { plan?: Plan | undefined; sourceIssue?: number | undefined } = {}): string {
  return renderHumanReviewFromEvidence(evidenceFromSnapshot(snap, opts));
}

/** A concise, non-technical human-review block built from full evidence. */
export function renderHumanReviewFromEvidence(e: PrEvidence): string {
  const decision = decidePrVerdict(e);
  const manual = buildManualChecks(e);
  const rows = namedCheckRows(e);
  const L: string[] = [];
  L.push(`## 🧑‍💼 Plain-English review (for non-technical reviewers)`);
  L.push('');
  L.push(`**Verdict:** ${VERDICT_BADGE[decision.verdict]} · **Risk:** ${decision.riskLevel}`);
  L.push('');
  L.push(`**Recommendation:** ${decision.recommendation}`);
  L.push('');
  L.push(`**What this does:** ${oneLine(e.goal) || '(see title)'}`);
  L.push('');
  L.push(`**Verification:** ${e.verifiedCompleted}/${e.totalSlices} pieces verified · ` + rows.map((r) => `${r.label} ${r.ok === undefined ? '—' : r.ok ? '✅' : '❌'}`).join(' · '));
  L.push('');
  const mk = (v: boolean | undefined): string => (v === undefined ? '⚠️' : v ? '✅' : '❌');
  L.push(`**Security:** secrets ${mk(e.security.secrets)} · forbidden files ${mk(e.security.forbiddenPaths)} · protected locations ${mk(e.security.protectedFiles)}`);
  L.push('');
  L.push(`**You should manually check before merging:**`);
  manual.slice(0, 8).forEach((c, i) => L.push(`${i + 1}. ${c}`));
  L.push('');
  L.push(`> ⚠️ **No auto-merge was performed. No deployment happened. Human review is required** before merging.`);
  L.push(`> For the full evidence-based report (checks, AI reviewer, screenshots, file groups), run \`agent-loop github pr review --repo <owner>/<name> --pr <number>\`.`);
  return L.join('\n');
}

// --- top-level builder -------------------------------------------------------

export function buildPrReview(input: ExtractInput): PrReviewReport {
  const evidence = extractEvidence(input);
  const decision = decidePrVerdict(evidence);
  return {
    ...decision,
    manualChecks: buildManualChecks(evidence),
    evidence,
    generatedFrom: evidence.hasLocalRun ? 'local-run' : 'pr-metadata-only',
  };
}

// --- file grouping (user-friendly categories) --------------------------------

export function groupFiles(files: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const add = (g: string, f: string): void => {
    (groups[g] ??= []).push(f);
  };
  for (const f of files) {
    if (/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[tj]sx?$/.test(f)) add('Tests', f);
    else if (/\.(tsx|jsx|css|scss|sass|less|html|vue|svelte)$/.test(f)) add('User interface', f);
    else if (/\.(md|mdx|txt|rst)$/.test(f)) add('Documentation', f);
    else if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|.*\.ya?ml|.*\.config\.[tj]s|\.[a-z]+rc)$/.test(f)) add('Configuration', f);
    else if (/\.(ts|js|mjs|cjs|py|go|rb|rs|java|php)$/.test(f)) add('App logic', f);
    else add('Other', f);
  }
  return groups;
}

function baseName(p: string): string {
  return p.split('/').pop() ?? p;
}

// --- markdown rendering ------------------------------------------------------

const VERDICT_BADGE: Record<PrVerdict, string> = {
  'SAFE TO REVIEW': '🟢 SAFE TO REVIEW',
  'NEEDS HUMAN DEV REVIEW': '🟡 NEEDS HUMAN DEV REVIEW',
  'DO NOT MERGE': '🔴 DO NOT MERGE',
  BLOCKED: '⛔ BLOCKED',
};

const CHECK_MARK = (ok: boolean | undefined): string => (ok === undefined ? '— not run' : ok ? '✅ PASS' : '❌ FAIL');
/** Safety guards: `undefined` is a GAP (scan left no evidence it ran), not a pass. */
const SAFETY_MARK = (ok: boolean | undefined): string => (ok === undefined ? '⚠️ NOT CHECKED' : ok ? '✅ PASS' : '❌ FAIL');

/** Render the full plain-English report. Caller is responsible for redaction. */
export function renderPrReviewMarkdown(report: PrReviewReport): string {
  const e = report.evidence;
  const L: string[] = [];
  const title = e.pr ? `PR #${e.pr.number}` : `branch \`${e.branch || '(unknown)'}\``;

  L.push(`# Plain-English review — ${title}`);
  L.push('');
  L.push(`> Generated by agent-loop from objective run evidence. **No code was merged, deployed, or closed.** A human still decides.`);
  L.push('');
  L.push(`## Verdict`);
  L.push('');
  L.push(`### ${VERDICT_BADGE[report.verdict]}`);
  L.push('');
  L.push(`**Risk level:** ${report.riskLevel}`);
  L.push('');
  L.push(`**Recommendation:** ${report.recommendation}`);
  if (report.reasons.length) {
    L.push('');
    for (const r of report.reasons) L.push(`- ${r}`);
  }
  L.push('');

  L.push(`## Plain-English summary`);
  L.push('');
  L.push(plainSummary(report));
  L.push('');

  L.push(`## What changed`);
  L.push('');
  if (e.review?.productOwner?.whatChanged) {
    L.push(e.review.productOwner.whatChanged);
    L.push('');
  }
  const completed = e.slices.filter((s) => s.state === 'COMPLETED');
  if (completed.length) {
    for (const s of completed) L.push(`- **${s.title}**${s.commit ? ` (commit \`${s.commit.slice(0, 8)}\`)` : ''}`);
  } else {
    L.push(`- (no completed pieces of work)`);
  }
  L.push('');

  L.push(`## Why it changed`);
  L.push('');
  L.push(e.sourceIssue ? `To address GitHub issue #${e.sourceIssue}: “${oneLine(e.goal)}”.` : `Goal: “${oneLine(e.goal)}”.`);
  if (e.review?.productOwner) L.push('', `Does the result match the request? **${matchLabel(e.review.productOwner.matchesIntent)}** (AI reviewer’s read).`);
  L.push('');

  L.push(`## Checks`);
  L.push('');
  L.push(`| Check | Result |`);
  L.push(`| --- | --- |`);
  for (const row of namedCheckRows(e)) L.push(`| ${row.label} | ${CHECK_MARK(row.ok)} |`);
  L.push('');

  L.push(`## Security & safety`);
  L.push('');
  L.push(`| Guard | Result |`);
  L.push(`| --- | --- |`);
  for (const g of sec(e)) L.push(`| ${g.label} | ${SAFETY_MARK(g.value)} |`);
  if (e.security.lockfileChanged) L.push(`| Dependency lockfile | ⚠️ changed (confirm intended) |`);
  L.push('');

  L.push(`## Main risks`);
  L.push('');
  if (report.concerns.length) for (const c of report.concerns) L.push(`- ${c}`);
  else L.push(`- No notable risks were flagged by the automatic checks. Manual review still required.`);
  if (e.review?.productOwner?.riskExplanation) L.push('', `> Reviewer’s plain-English risk note: ${e.review.productOwner.riskExplanation}`);
  L.push('');

  L.push(`## What you should manually check`);
  L.push('');
  report.manualChecks.forEach((c, i) => L.push(`${i + 1}. ${c}`));
  L.push('');

  // Screenshots / browser evidence
  L.push(`## Screenshots & browser evidence`);
  L.push('');
  if (e.browser?.ran) {
    L.push(`Browser/UI check ran with engine **${e.browser.engine}** over ${e.browser.routes} route(s): **${e.browser.ok ? 'passed' : 'did NOT fully pass'}**${e.browser.required ? ' (required)' : ' (advisory)'}.`);
    if (e.browser.artifacts.length) {
      L.push('');
      for (const a of e.browser.artifacts) L.push(`- \`${a}\``);
    }
  } else {
    L.push(`No browser/UI verification was run for this change.`);
  }
  L.push('');

  // Files grouped
  L.push(`## Files changed`);
  L.push('');
  const groups = groupFiles(e.changedFiles);
  if (Object.keys(groups).length === 0) {
    L.push(`- (no files recorded)`);
  } else {
    for (const [g, fs] of Object.entries(groups)) {
      L.push(`**${g}** (${fs.length})`);
      for (const f of fs.slice(0, 30)) L.push(`- \`${f}\``);
      if (fs.length > 30) L.push(`- …and ${fs.length - 30} more`);
      L.push('');
    }
  }

  // Technical details (secondary)
  L.push(`<details>`);
  L.push(`<summary>Technical details (for developers)</summary>`);
  L.push('');
  L.push(`- **Run:** \`${e.runId || '(none)'}\` · **State:** ${e.runState} · **Branch:** \`${e.branch}\``);
  L.push(`- **Verified progress:** ${e.verifiedCompleted}/${e.totalSlices} slices`);
  if (e.costUsd > 0 || e.tokens > 0) L.push(`- **Cost:** $${e.costUsd.toFixed(4)} / ${e.tokens} tokens`);
  if (e.pr) L.push(`- **PR:** ${e.pr.url} (state ${e.pr.state}${e.pr.isDraft ? ', draft' : ''}, head \`${e.pr.headRefName}\`)`);
  L.push('');
  if (e.commits.length) {
    L.push(`**Commits (${e.commits.length}):**`);
    for (const c of e.commits) L.push(`- \`${c.sha.slice(0, 8)}\` ${oneLine(c.message)}`);
    L.push('');
  }
  if (e.review) {
    L.push(`**AI reviewer:** verdict \`${e.review.verdict}\`${e.review.malformed ? ' (output unparseable → advisory pass)' : ''}, ${e.review.totalFindings} finding(s), providers: ${e.review.providers.join(', ') || '(n/a)'}`);
    for (const f of e.review.findings.slice(0, 20)) {
      L.push(`- [${f.severity}]${f.file ? ` \`${f.file}\`` : ''}: ${f.description}${f.requiredAction ? ` — _action:_ ${f.requiredAction}` : ''}`);
    }
    L.push('');
  } else {
    L.push(`**AI reviewer:** not run.`);
    L.push('');
  }
  if (e.blocker) L.push(`**Blocker:** ${e.blocker.reason}${e.blocker.details ? ` — ${e.blocker.details}` : ''}`, '');
  if (e.assumptions.length) {
    L.push(`**Recorded assumptions:**`);
    for (const a of e.assumptions) L.push(`- ${a}`);
    L.push('');
  }
  L.push(`</details>`);
  L.push('');

  L.push(`---`);
  L.push(`**Reminder:** agent-loop never merges, deploys, or closes issues automatically. This report is advice based on evidence — a human makes the final call. The deterministic checks are the authority; the AI reviewer can flag problems but can never approve over a failed check.`);
  L.push('');
  return L.join('\n');
}

function plainSummary(report: PrReviewReport): string {
  const e = report.evidence;
  const goal = oneLine(e.goal) || 'the requested change';
  const work = e.totalSlices > 0 ? `${e.verifiedCompleted} of ${e.totalSlices} planned piece(s) of work` : 'the change';
  const reviewLine = e.review
    ? e.review.verdict === 'pass'
      ? ' A second AI reviewer looked at the code and did not object.'
      : e.review.verdict === 'changes_requested'
        ? ' A second AI reviewer suggested changes.'
        : ' A second AI reviewer raised a blocking concern.'
    : '';
  const browserLine = e.browser?.ran ? ` The app was opened in a browser and the screen was ${e.browser.ok ? 'captured successfully' : 'flagged as not fully correct'}.` : '';
  if (report.verdict === 'SAFE TO REVIEW') {
    return `agent-loop worked on “${goal}”. It completed ${work}, and **every automatic safety and test check passed**.${reviewLine}${browserLine} Nothing was merged or deployed — this is a draft for you to review and merge by hand once the checks below look right.`;
  }
  if (report.verdict === 'NEEDS HUMAN DEV REVIEW') {
    return `agent-loop worked on “${goal}” and completed ${work}. The automatic checks passed, **but there are a few things a developer should confirm** before this is merged (see “Main risks”).${reviewLine}${browserLine} Nothing was merged or deployed.`;
  }
  if (report.verdict === 'DO NOT MERGE') {
    return `agent-loop worked on “${goal}”, but **this should not be merged as-is**: ${report.reasons[0] ?? 'automatic checks did not pass'}.${reviewLine}${browserLine} Nothing was merged or deployed.`;
  }
  return `agent-loop attempted “${goal}” but the work was **stopped by a safety check** and is not safe to merge: ${report.reasons[0] ?? 'a hard safety violation was detected'}. Nothing was merged or deployed.`;
}

function namedCheckRows(e: PrEvidence): CheckRow[] {
  // Prefer the well-known named checks first, in a stable order.
  const order = ['Tests', 'Build', 'Typecheck', 'Lint'];
  const byLabel = new Map<string, boolean | undefined>();
  for (const c of e.checks) {
    const prev = byLabel.get(c.label);
    // AND-combine duplicates (any fail = fail; undefined only if never seen).
    byLabel.set(c.label, prev === undefined ? c.ok : prev === false ? false : c.ok === false ? false : prev && c.ok);
  }
  const rows: CheckRow[] = [];
  for (const label of order) if (byLabel.has(label)) rows.push({ id: label, label, ok: byLabel.get(label) });
  for (const [label, ok] of byLabel) if (!order.includes(label)) rows.push({ id: label, label, ok });
  if (e.browser?.ran) rows.push({ id: 'browser', label: 'Browser/UI', ok: e.browser.ok });
  if (rows.length === 0) rows.push({ id: 'none', label: 'Project checks', ok: undefined });
  return rows;
}

function matchLabel(m: ProductOwnerSummary['matchesIntent']): string {
  return m === 'yes' ? 'Yes' : m === 'partly' ? 'Partly' : m === 'no' ? 'No' : 'Unsure';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}
