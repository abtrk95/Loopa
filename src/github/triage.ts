/**
 * Issue triage. Classifies GitHub issues as ready / needs-info / too-risky /
 * unsupported using deterministic heuristics, and (in apply mode) records the
 * classification as a label and optionally comments clarification questions.
 *
 * Triage NEVER starts work. It only decides whether an issue is clear and safe
 * enough to plan. Unclear issues get clarification questions (from the interview
 * catalog) rather than weak slices.
 */
import type { GhClient, GhIssue } from './client.js';
import type { GithubConfig } from '../config/config.js';
import { clarificationPrompts, type InterviewMode } from '../intake/interview.js';
import { heuristicRisk } from '../planner/plan.js';
import { labelForTriage, triggerLabels, LABEL_COLORS, type TriageStatus } from './labels.js';
import { errorMessage } from '../domain/errors.js';
import type { Risk } from '../domain/schemas.js';

/** Best-effort label color from the label's suffix (e.g. agent-loop:ready → ready). */
function labelColor(label: string): string {
  return LABEL_COLORS[label.split(':').pop() ?? ''] ?? 'ededed';
}

export interface TriageResult {
  number: number;
  title: string;
  url?: string;
  status: TriageStatus;
  risk: Risk;
  reasons: string[];
  /** Clarification questions for needs-info / too-risky issues. */
  clarifications: string[];
  /** Labels that would be (or were) added/removed. */
  labelsAdded: string[];
  labelsRemoved: string[];
  commented: boolean;
}

export interface TriageOptions {
  repo: string;
  mode: InterviewMode;
  /** Post clarification questions on needs-info/too-risky issues (writes gated by client dry-run). */
  comment: boolean;
  /** Only consider issues bearing a trigger label (default true). */
  onlyTriggered: boolean;
  /** Triage a single issue instead of listing. */
  issue?: number;
  limit?: number;
}

export interface TriageReport {
  repo: string;
  dryRun: boolean;
  considered: number;
  skipped: number;
  results: TriageResult[];
}

const ACTIONABLE_RE = /\b(implement|add|fix|create|build|refactor|update|remove|support|enable|migrate|write|integrate|expose|handle)\b/i;
const QUESTION_TITLE_RE = /\?\s*$/;
const MIN_DETAIL = 80; // chars of body that count as "specified enough"

/** Extract `- [ ] ...` / `- [x] ...` checkbox lines as acceptance criteria. */
export function issueCheckboxes(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '').trim())
    .filter(Boolean);
}

/** Pure classification — no network. */
export function classifyIssue(issue: GhIssue, mode: InterviewMode): TriageResult {
  const body = (issue.body ?? '').trim();
  const checkboxes = issueCheckboxes(body);
  const hasAC = checkboxes.length > 0;
  const detailed = body.length >= MIN_DETAIL;
  const risk = heuristicRisk(`${issue.title} ${body}`);
  const actionable = ACTIONABLE_RE.test(`${issue.title} ${body}`);
  const reasons: string[] = [];

  let status: TriageStatus;
  if (!actionable && (QUESTION_TITLE_RE.test(issue.title) || body.length < MIN_DETAIL)) {
    // A question/support/discussion item, not an implementable change request.
    status = 'unsupported';
    reasons.push('reads as a question/discussion, not an actionable change request');
  } else if (risk === 'high' && !hasAC) {
    status = 'too-risky';
    reasons.push('high-risk keywords with no explicit acceptance criteria — needs a human');
  } else if (hasAC || detailed) {
    status = 'ready';
    if (hasAC) reasons.push(`${checkboxes.length} acceptance criterion/criteria found`);
    if (detailed) reasons.push('body is specified enough to plan');
  } else {
    status = 'needs-info';
    reasons.push('too little detail and no acceptance criteria to plan from');
  }

  const clarifications =
    status === 'needs-info' || status === 'too-risky'
      ? clarificationPrompts(mode, {
          goal: Boolean(issue.title.trim()),
          acceptanceCriteria: hasAC,
          background: detailed,
          verificationCommands: false,
        })
      : [];

  return {
    number: issue.number,
    title: issue.title,
    ...(issue.url ? { url: issue.url } : {}),
    status,
    risk,
    reasons,
    clarifications,
    labelsAdded: [],
    labelsRemoved: [],
    commented: false,
  };
}

/** Classify (and, when not dry-run, apply labels/comments to) a repo's issues. */
export async function triageRepo(client: GhClient, cfg: GithubConfig, opts: TriageOptions): Promise<TriageReport> {
  const triggers = new Set(triggerLabels(cfg));
  const classificationLabels = [cfg.labels.ready, cfg.labels.needsInfo, cfg.labels.tooRisky, cfg.labels.unsupported];

  let issues: GhIssue[];
  if (opts.issue !== undefined) {
    issues = [await client.viewIssue(opts.repo, opts.issue)];
  } else {
    issues = await client.listIssues(opts.repo, { state: 'open', limit: opts.limit ?? 50 });
  }

  let skipped = 0;
  const results: TriageResult[] = [];
  for (const issue of issues) {
    const triggered = issue.labels.some((l) => triggers.has(l));
    // Ignore issues without a configured trigger label unless explicitly requested
    // (single-issue triage or onlyTriggered=false).
    if (opts.onlyTriggered && opts.issue === undefined && !triggered) {
      skipped++;
      continue;
    }

    const result = classifyIssue(issue, opts.mode);
    // One issue's write failure must not crash the whole triage pass.
    try {
      await applyClassification(client, cfg, opts.repo, issue, result, { comment: opts.comment, classificationLabels });
    } catch (err) {
      result.reasons.push(`label/comment write failed: ${errorMessage(err)}`);
    }
    results.push(result);
  }

  return { repo: opts.repo, dryRun: client.isDryRun, considered: results.length, skipped, results };
}

/**
 * Apply a classification to an issue: add the status label, remove conflicting
 * classification labels, and (optionally) comment clarification questions. Every
 * write is gated by the client's dry-run flag. Mutates `result` with what changed.
 */
export async function applyClassification(
  client: GhClient,
  cfg: GithubConfig,
  repo: string,
  issue: GhIssue,
  result: TriageResult,
  opts: { comment: boolean; classificationLabels?: string[] },
): Promise<TriageResult> {
  const classificationLabels = opts.classificationLabels ?? [cfg.labels.ready, cfg.labels.needsInfo, cfg.labels.tooRisky, cfg.labels.unsupported];
  const wantLabel = labelForTriage(result.status, cfg.labels);
  const toRemove = classificationLabels.filter((l) => l !== wantLabel && issue.labels.includes(l));

  if (!issue.labels.includes(wantLabel)) {
    // Ensure the label exists on the repo first (best-effort) so adding it can't fail
    // just because the configured label was never created.
    await client.ensureLabel(repo, wantLabel, labelColor(wantLabel), 'agent-loop triage');
    await client.addLabels(repo, issue.number, [wantLabel]);
    result.labelsAdded = [wantLabel];
  }
  if (toRemove.length) {
    await client.removeLabels(repo, issue.number, toRemove);
    result.labelsRemoved = toRemove;
  }
  if (opts.comment && result.clarifications.length > 0) {
    await client.comment(repo, issue.number, clarificationComment(result));
    result.commented = true;
  }
  return result;
}

export function clarificationComment(result: TriageResult): string {
  const lines = [
    `**agent-loop triage: ${result.status}**`,
    '',
    `This issue isn't ready to plan yet (${result.reasons.join('; ')}). Could you clarify:`,
    '',
    ...result.clarifications.map((q) => `- ${q}`),
    '',
    '_Once these are answered, re-label this issue to mark it ready. agent-loop will not start work until then, and never auto-merges or deploys._',
  ];
  return lines.join('\n');
}
