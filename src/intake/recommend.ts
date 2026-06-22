/**
 * Interview recommendation engine (pure, unit-testable, no I/O).
 *
 * For EVERY interview question the engine produces a {@link Recommendation}: a
 * recommended answer, *why* it fits the user's input + detected repo + risk, the
 * realistic alternatives, a risk/impact note, the conservative safe default, and
 * whether the answer is required or optional.
 *
 * Two hard rules keep recommendations safe:
 *  1. A recommendation NEVER weakens the deterministic verifier. It can only pick
 *     providers/models/concurrency (which the verifier always dominates) or RAISE
 *     a safety floor (more checks, required browser verification, human gates).
 *  2. The conservative `safeDefault` is what `--auto` / non-interactive runs use.
 *     The `recommended` value is what an interactive user (or `--accept-recommended`)
 *     gets; for any safety-relevant question it is never *less* safe than the
 *     safe default (e.g. a high-risk task recommends autonomous=NO).
 *
 * The CLI builds the {@link RecommendInputs} (detecting stack, git state, providers,
 * config) and renders the recommendations; this module stays free of stdin/process
 * so it can be exhaustively tested.
 */
import type { InterviewAnswers, InterviewMode } from './interview.js';
import type { Config } from '../config/config.js';

/** A single, fully-explained recommendation for one interview question. */
export interface Recommendation {
  /** The question key (matches a key of {@link InterviewAnswers}). */
  key: keyof InterviewAnswers;
  /** Which part of the run it shapes. */
  section: 'objective' | 'orchestration';
  /** The question text shown to the user. */
  question: string;
  /** The recommended answer, as the raw string a user would type (drives parsing). */
  recommended: string;
  /** Human-readable label for the recommended value (when different from raw). */
  recommendedLabel?: string;
  /** Why this recommendation fits the user's input, repo, and risk. */
  why: string;
  /** Other reasonable choices. */
  alternatives: string[];
  /** Risk / impact note for the recommended choice. */
  risk: string;
  /** The conservative fallback used in --auto / non-interactive runs. */
  safeDefault: string;
  /** Whether an answer is required (true) or optional (false). */
  required: boolean;
}

/** Availability of a provider, as observed by the registry/doctor at runtime. */
export interface ProviderInfo {
  id: string;
  installed: boolean;
  roles: string[];
}

/** Repo + input signals the recommendation engine reasons over. */
export interface RepoSignals {
  /** Detected stack tags, e.g. ['node','typescript','vitest']. */
  stack: string[];
  packageManager?: string | undefined;
  /** package.json script names. */
  packageScripts: string[];
  /** Detected verification check ids (npm run typecheck/lint/test/build, …). */
  detectedChecks: string[];
  /** Detected verification commands (human-readable), for the recommended answer. */
  detectedCommands: string[];
  gitClean: boolean;
  gitBranch?: string | undefined;
  /** Heuristic: the work touches UI/browser surfaces. */
  uiSignal: boolean;
  /** Heuristic: a GitHub/PR workflow was requested. */
  githubSignal: boolean;
  /** Heuristic: the goal looks high-risk (auth/payment/migration/infra/…). */
  highRisk: boolean;
  /** Heuristic: the goal looks medium-risk (api/schema/config/…). */
  mediumRisk: boolean;
  /** Heuristic: the goal likely decomposes into multiple slices. */
  multiSlice: boolean;
}

export interface RecommendInputs {
  mode: InterviewMode;
  /** Combined goal/background/issue text used for keyword analysis. */
  goalText: string;
  signals: RepoSignals;
  /** Providers observed available (installed) and their roles. */
  providers: ProviderInfo[];
  /** The current resolved config (for current defaults). */
  config: Config;
  /** Whether the run is unattended. */
  auto: boolean;
}

const HIGH_RISK_RE = /\b(auth|authentication|password|secret|payment|billing|crypto|security|migration|migrate|delete|drop|production|infra|deploy)\b/i;
const MEDIUM_RISK_RE = /\b(database|schema|api|endpoint|config|permission|role|upload|webhook|queue)\b/i;
const UI_RE = /\b(ui|page|route|frontend|front-end|button|form|screen|component|css|html|dashboard|view|render|browser|navbar|modal)\b/i;
const GITHUB_RE = /\b(github|pull request|pr|issue|kanban|project board|draft pr)\b/i;
const MULTI_RE = /\b(and|,|with|plus|also|validation|tests?|docs?|multiple|several|both|two)\b/i;

/**
 * Compute the heuristic signals from input text + detected stack. Pure; the CLI
 * passes git/provider facts in separately.
 */
export function computeSignals(args: {
  goalText: string;
  stack: string[];
  packageManager?: string | undefined;
  packageScripts: string[];
  detectedChecks: string[];
  detectedCommands: string[];
  gitClean: boolean;
  gitBranch?: string | undefined;
  githubRequested?: boolean;
}): RepoSignals {
  const t = args.goalText ?? '';
  const uiSignal = UI_RE.test(t) || args.stack.includes('react') || args.stack.includes('next');
  return {
    stack: args.stack,
    packageManager: args.packageManager,
    packageScripts: args.packageScripts,
    detectedChecks: args.detectedChecks,
    detectedCommands: args.detectedCommands,
    gitClean: args.gitClean,
    gitBranch: args.gitBranch,
    uiSignal,
    githubSignal: Boolean(args.githubRequested) || GITHUB_RE.test(t),
    highRisk: HIGH_RISK_RE.test(t),
    mediumRisk: MEDIUM_RISK_RE.test(t),
    // "multi-slice" when the goal joins several deliverables (and/with/tests/docs/…).
    multiSlice: MULTI_RE.test(t) && t.trim().split(/\s+/).length > 6,
  };
}

// --- provider helpers --------------------------------------------------------

const PREFERRED_WORKERS = ['claude', 'codex', 'opencode'];

function realInstalled(inputs: RecommendInputs, role?: string): ProviderInfo[] {
  return inputs.providers.filter(
    (p) => p.id !== 'fake' && p.installed && (role ? p.roles.includes(role) : true),
  );
}

/** The strongest installed real provider for a role, by preference order, or undefined. */
function bestReal(inputs: RecommendInputs, role: string): string | undefined {
  const installed = realInstalled(inputs, role).map((p) => p.id);
  for (const pref of PREFERRED_WORKERS) if (installed.includes(pref)) return pref;
  return installed[0];
}

/** A real provider distinct from `other`, for review/fallback diversity. */
function distinctReal(inputs: RecommendInputs, role: string, other: string | undefined): string | undefined {
  const installed = realInstalled(inputs, role).map((p) => p.id);
  for (const pref of PREFERRED_WORKERS) if (pref !== other && installed.includes(pref)) return pref;
  return installed.find((id) => id !== other);
}

function noRealNote(): string {
  return 'No real provider (claude/codex/opencode) is installed — `fake` only completes the built-in demo. Install and authenticate one for real work.';
}

// --- the recommendation catalog ----------------------------------------------

type Recommender = (i: RecommendInputs) => Omit<Recommendation, 'key' | 'section' | 'question'>;

/** Objective-shaping questions (fold into the Objective; planning quality only). */
const OBJECTIVE_RECOMMENDERS: Partial<Record<keyof InterviewAnswers, Recommender>> = {
  goal: () => ({
    recommended: '',
    why: 'Taken from your idea/PRD/issue input when present; otherwise you must state it.',
    alternatives: [],
    risk: 'An unclear goal yields weak, over-broad slices.',
    safeDefault: '(required — no safe default; the interview blocks without a goal)',
    required: true,
  }),
  acceptanceCriteria: (i) => ({
    recommended: deriveAcceptance(i),
    why: 'Concrete, checkable criteria sharpen each slice and define "done" precisely.',
    alternatives: ['List specific user-visible behaviors', 'Reference the issue checkboxes', 'Leave blank to default to "goal met + all checks pass"'],
    risk: 'Without criteria, "done" = goal satisfied and all verification checks pass (less precise, still safe).',
    safeDefault: 'satisfy the goal end-to-end and pass all verification checks',
    required: false,
  }),
  verificationCommands: (i) => ({
    recommended: i.signals.detectedCommands.join(', '),
    why: i.signals.detectedCommands.length
      ? `Detected from your project tooling (${i.signals.stack.join(', ') || 'package.json scripts'}): these are the SAME checks a developer runs.`
      : 'No build/test tooling was detected; the scope, secret, and diff-size checks still apply to every slice.',
    alternatives: ['Add an end-to-end / integration command', 'Restrict to a faster subset for quick iteration'],
    risk: 'These gate EVERY slice and final verification. Weak or missing checks weaken the safety net; they can only be added, never removed by the agent.',
    safeDefault: i.signals.detectedCommands.length ? i.signals.detectedCommands.join(', ') : '(none detected — scope/secret/diff checks only)',
    required: i.signals.highRisk,
  }),
  successCriteria: () => ({
    recommended: '',
    why: 'Optional high-level outcomes beyond the goal; helpful for multi-slice work.',
    alternatives: ['Leave blank — the goal and verification checks define success'],
    risk: 'Advisory only; never gates the deterministic verifier.',
    safeDefault: 'the goal and the verification checks',
    required: false,
  }),
  background: () => ({
    recommended: '',
    why: 'Context the agent cannot infer from the repo (product intent, history, constraints).',
    alternatives: ['Leave blank — the agent infers context from the repository'],
    risk: 'Missing context can lead the agent to wrong assumptions (recorded explicitly).',
    safeDefault: 'inferred from the repository',
    required: false,
  }),
  userVisibleBehavior: () => ({
    recommended: '',
    why: 'Describe what the user should observe; anchors UI/behavioral acceptance.',
    alternatives: ['Leave blank if there is no user-visible change'],
    risk: 'Advisory; does not gate the verifier.',
    safeDefault: 'none specified',
    required: false,
  }),
  nonGoals: () => ({
    recommended: '',
    why: 'Explicit out-of-scope items keep slices tight and prevent scope creep.',
    alternatives: ['Leave blank — scope is limited strictly to the stated goal'],
    risk: 'Without non-goals the agent stays within the goal, but boundaries are softer.',
    safeDefault: 'scope limited strictly to the stated goal',
    required: false,
  }),
  constraints: (i) => ({
    recommended: '',
    why: `Technical constraints the work must respect (e.g. "stay within ${i.signals.stack[0] ?? 'the existing stack'}", "no new dependencies").`,
    alternatives: ['Leave blank — no extra constraints'],
    risk: 'Advisory context for the agent; the verifier still enforces scope/secret/diff rules.',
    safeDefault: 'none beyond the detected stack',
    required: false,
  }),
  forbiddenPaths: () => ({
    recommended: '',
    why: 'Extra paths the agent must never touch. Built-in protections (.env, secrets/**, .git/**) always apply and are unioned in.',
    alternatives: ['Add legacy/vendored dirs you do not want changed', 'Leave blank — built-in protections still apply'],
    risk: 'Forbidden paths can only be ADDED (scope can never be widened into secrets).',
    safeDefault: 'built-in secret/infra protections only',
    required: false,
  }),
  risk: (i) => ({
    recommended: i.signals.highRisk ? 'high' : i.signals.mediumRisk ? 'medium' : 'low',
    why: i.signals.highRisk
      ? 'Your goal mentions sensitive areas (auth/payment/security/migration/infra) — treat it as high risk.'
      : i.signals.mediumRisk
        ? 'Your goal touches API/schema/config surfaces — medium risk is prudent.'
        : 'No high-risk keywords detected; low risk is reasonable but the planner heuristic still applies.',
    alternatives: ['low', 'medium', 'high'],
    risk: 'Risk can only be RAISED, never lowered: a higher level adds reviewer gates. Declaring "low" on a risky goal does NOT bypass the heuristic floor.',
    safeDefault: 'let the planner heuristic decide (raised by any explicit answer)',
    required: false,
  }),
  browserVerification: (i) => ({
    recommended: i.signals.uiSignal ? 'y' : 'n',
    why: i.signals.uiSignal
      ? 'Your goal/stack involves UI (pages/routes/components), so browser verification adds real coverage.'
      : 'No UI surface detected; browser verification would add setup cost with little benefit.',
    alternatives: ['y — capture screenshots + console errors per route', 'n — rely on unit/integration checks'],
    risk: 'Browser verification needs a start command + a Chrome/Chromium binary; without them it falls back to an HTTP probe.',
    safeDefault: 'n (no browser verification)',
    required: false,
  }),
  githubIntegration: (i) => ({
    recommended: i.signals.githubSignal ? 'y' : 'n',
    why: i.signals.githubSignal
      ? 'A GitHub/PR workflow was requested or implied; enabling it lets agent-loop open a DRAFT PR and move labels.'
      : 'No GitHub workflow implied; keep it off for a purely local run.',
    alternatives: ['y — draft PR + label/Kanban sync', 'n — local only'],
    risk: 'GitHub integration only ever opens DRAFT PRs and moves labels; it never merges, deploys, or closes issues.',
    safeDefault: 'n (local only)',
    required: false,
  }),
  autonomous: (i) => ({
    // Always default to attended; high-risk work in particular should keep a human in the loop.
    recommended: 'n',
    why: i.signals.highRisk
      ? 'This looks high-risk — keep a human in the loop. Autonomy does not pause for approval.'
      : 'Default to attended for the first run; switch to autonomous once you trust the plan.',
    alternatives: ['y — run unattended (still gated by the verifier; never auto-merges)', 'n — pause at human checkpoints'],
    risk: i.signals.highRisk
      ? 'Autonomous + high-risk is discouraged: completion is still verifier-gated, but no human reviews intermediate steps.'
      : 'Autonomous runs do not stop for approval; the verifier still gates completion and nothing is merged/deployed.',
    safeDefault: 'n (attended)',
    required: false,
  }),
  architecture: () => ({
    recommended: '',
    why: 'Existing architecture the work must fit into; otherwise the agent infers it.',
    alternatives: ['Leave blank — inferred from the repository'],
    risk: 'Advisory context only.',
    safeDefault: 'inferred from the repository',
    required: false,
  }),
  mergePolicy: () => ({
    recommended: 'Manual review required; agent-loop never auto-merges or deploys.',
    why: 'agent-loop is strengthen-only: a human always reviews the draft PR before merge.',
    alternatives: ['Document a specific reviewer/branch policy'],
    risk: 'This is enforced regardless: there is no auto-merge/auto-deploy path.',
    safeDefault: 'Manual review required; never auto-merges/deploys',
    required: false,
  }),
  humanCheckpoints: (i) => ({
    recommended: i.signals.highRisk ? 'before opening the PR' : '',
    why: i.signals.highRisk
      ? 'For high-risk work, an explicit human checkpoint before the PR adds a deliberate gate.'
      : 'Optional approval gates; final completion already requires verified slices.',
    alternatives: ['before each high-risk slice', 'before opening the PR', 'none'],
    risk: 'Checkpoints add safety but pause progress; the verifier gates completion regardless.',
    safeDefault: 'none (final completion still requires verified slices)',
    required: false,
  }),
  stopConditions: () => ({
    recommended: '',
    why: 'Conditions that should halt the run; sensible defaults already apply.',
    alternatives: ['Add a budget or time cap', 'Leave blank — defaults apply'],
    risk: 'Defaults already stop on any verification failure after retries, or any out-of-scope/secret change.',
    safeDefault: 'any verification failure after retries, or out-of-scope/secret changes',
    required: false,
  }),
};

/** Orchestration questions (fold into CONFIG; strengthen-only). */
const ORCHESTRATION_RECOMMENDERS: Partial<Record<keyof InterviewAnswers, Recommender>> = {
  plannerProvider: (i) => {
    const best = bestReal(i, 'planner');
    return {
      recommended: best ?? 'fake',
      why: best
        ? `${best} is installed and strong at decomposing work into small, verifiable slices.`
        : noRealNote(),
      alternatives: providerAlternatives(i, 'planner', best),
      risk: 'The planner shapes the slice graph; a weak planner yields poor decomposition (but the verifier still gates every slice).',
      safeDefault: 'fake (deterministic; demo only)',
      required: false,
    };
  },
  workerProviders: (i) => {
    const best = bestReal(i, 'worker');
    return {
      recommended: best ?? 'fake',
      recommendedLabel: best ? `single worker: ${best}` : 'single worker: fake',
      why: best
        ? `Start with one capable worker (${best}). Overlapping scopes serialize regardless, so a single worker is the safe, conflict-free default.`
        : noRealNote(),
      alternatives: [
        ...(realInstalled(i, 'worker').length >= 2 ? [`multiple workers: ${realInstalled(i, 'worker').map((p) => p.id).join(', ')} (diverse, for independent slices)`] : []),
        'a single worker (recommended to start)',
      ],
      risk: 'Multiple workers speed up INDEPENDENT slices but can increase merge/scope churn; overlapping path scopes always serialize for safety.',
      safeDefault: best ?? 'fake',
      required: false,
    };
  },
  concurrency: (i) => ({
    recommended: '1',
    why: 'Begin conservatively at concurrency 1. Overlapping scopes serialize anyway; raise this only once slices are proven independent.',
    alternatives: [
      '1 — sequential (recommended to start)',
      ...(i.signals.multiSlice && !i.signals.highRisk ? ['2 — parallel for clearly independent slices'] : []),
    ],
    risk: 'Higher concurrency parallelizes independent, parallel-safe slices via isolated worktrees, but increases integration churn. The scheduler never parallelizes overlapping scopes.',
    safeDefault: '1 (sequential)',
    required: false,
  }),
  reviewerProvider: (i) => {
    const worker = bestReal(i, 'worker');
    const rec = i.signals.highRisk ? distinctReal(i, 'reviewer', worker) : undefined;
    return {
      recommended: rec ?? 'none',
      why: i.signals.highRisk
        ? rec
          ? `High-risk work benefits from a second, DISTINCT model (${rec}) reviewing each diff. The reviewer is advisory and can never override the deterministic verifier.`
          : 'High-risk work benefits from a reviewer, but no distinct second provider is installed.'
        : 'For low/medium-risk work the deterministic verifier is sufficient; skip the reviewer to save cost/latency.',
      alternatives: ['none — verifier only', ...providerAlternatives(i, 'reviewer', rec)],
      risk: 'A reviewer adds latency/cost and STRENGTHENS review, but it can never pass a slice the verifier failed (out-of-scope, secrets, failed checks).',
      safeDefault: 'none (deterministic verifier only)',
      required: false,
    };
  },
  reviewerConsensus: (i) => {
    const can = realInstalled(i, 'reviewer').length >= 2;
    return {
      recommended: i.signals.highRisk && can ? 'y' : 'n',
      why: i.signals.highRisk && can
        ? 'High-risk + ≥2 installed providers: a consensus of distinct reviewers catches more issues.'
        : 'Consensus needs ≥2 distinct providers and adds cost; a single reviewer (or the verifier alone) is fine here.',
      alternatives: ['y — require multiple distinct reviewers to agree', 'n — single reviewer / verifier only'],
      risk: 'Consensus increases cost linearly with votes; it strengthens review but never overrides the verifier.',
      safeDefault: 'n (single reviewer / verifier only)',
      required: false,
    };
  },
  fixerStrategy: (i) => ({
    recommended: 'same-as-worker',
    why: 'Reusing the worker preserves the slice context for the fix attempt. Switch to a dedicated fixer only if one provider repeatedly fails the same slice.',
    alternatives: ['same-as-worker (recommended)', ...providerAlternatives(i, 'fixer', undefined)],
    risk: 'The fixer only re-attempts a failed slice; the verifier re-checks the result either way.',
    safeDefault: 'same-as-worker',
    required: false,
  }),
  fallbackProvider: (i) => {
    const worker = bestReal(i, 'worker');
    const rec = distinctReal(i, 'worker', worker);
    return {
      recommended: rec ?? 'none',
      why: rec
        ? `A fallback (${rec}) lets a failed slice retry on a different provider instead of giving up.`
        : 'No second provider installed, so there is nothing to fall back to.',
      alternatives: ['none', ...providerAlternatives(i, 'worker', worker)],
      risk: 'A fallback adds resilience with no downside to safety; the verifier judges whichever provider produced the diff.',
      safeDefault: 'none',
      required: false,
    };
  },
  switchOnRetry: (i) => {
    const hasAlt = realInstalled(i, 'worker').length >= 2;
    return {
      recommended: hasAlt ? 'y' : 'n',
      why: hasAlt
        ? 'With ≥2 providers, switching providers on retry avoids repeating the same failure mode.'
        : 'Only one provider is available, so switching on retry has no alternative to move to.',
      alternatives: ['y — advance to the next provider on retry', 'n — retry with the fixer/same provider'],
      risk: 'Switching providers on retry is purely a routing choice; the verifier still gates the result.',
      safeDefault: 'n (retry with the fixer)',
      required: false,
    };
  },
  browserRequired: (i) => ({
    recommended: i.signals.highRisk && i.signals.uiSignal ? 'y' : 'n',
    why: i.signals.highRisk && i.signals.uiSignal
      ? 'High-risk UI work: make browser verification BLOCKING so a broken route fails the slice.'
      : 'Keep browser verification advisory (a failure is flagged, never blocks) until it is proven stable.',
    alternatives: ['y — required (a browser failure BLOCKS the slice)', 'n — advisory (failure is flagged only)'],
    risk: 'Required browser checks can block on flaky environments; advisory checks never override the verifier.',
    safeDefault: 'n (advisory)',
    required: false,
  }),
};

function providerAlternatives(inputs: RecommendInputs, role: string, exclude: string | undefined): string[] {
  return realInstalled(inputs, role)
    .map((p) => p.id)
    .filter((id) => id !== exclude);
}

function deriveAcceptance(i: RecommendInputs): string {
  const goal = firstSentence(i.goalText);
  if (!goal) return '';
  const checks = i.signals.detectedChecks.length ? '; all verification checks pass' : '';
  return `${goal} works end-to-end${checks}`;
}

function firstSentence(text: string): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const m = t.split(/(?<=[.!?])\s|\n/)[0] ?? t;
  return m.length > 120 ? m.slice(0, 117) + '…' : m;
}

/** All question keys this engine can recommend, by section. */
export const RECOMMENDABLE_OBJECTIVE_KEYS = Object.keys(OBJECTIVE_RECOMMENDERS) as (keyof InterviewAnswers)[];
export const RECOMMENDABLE_ORCHESTRATION_KEYS = Object.keys(ORCHESTRATION_RECOMMENDERS) as (keyof InterviewAnswers)[];

/** Build a recommendation for a single question key, given a question label. */
export function recommendationFor(
  key: keyof InterviewAnswers,
  question: string,
  inputs: RecommendInputs,
): Recommendation | undefined {
  const obj = OBJECTIVE_RECOMMENDERS[key];
  if (obj) return { key, section: 'objective', question, ...obj(inputs) };
  const orch = ORCHESTRATION_RECOMMENDERS[key];
  if (orch) return { key, section: 'orchestration', question, ...orch(inputs) };
  return undefined;
}

/** Build recommendations for a set of (key, question) pairs. */
export function buildRecommendations(
  questions: Array<{ key: keyof InterviewAnswers; prompt: string }>,
  inputs: RecommendInputs,
): Map<keyof InterviewAnswers, Recommendation> {
  const out = new Map<keyof InterviewAnswers, Recommendation>();
  for (const q of questions) {
    const rec = recommendationFor(q.key, q.prompt, inputs);
    if (rec) out.set(q.key, rec);
  }
  return out;
}

/** Render a recommendation as the multi-line block shown before a question. */
export function formatRecommendation(rec: Recommendation): string {
  const reco = rec.recommendedLabel ?? (rec.recommended === '' ? '(your input)' : rec.recommended);
  const lines = [
    `Question:`,
    `  ${rec.question}`,
    ``,
    `Recommended:`,
    `  ${reco}`,
    ``,
    `Why:`,
    `  ${rec.why}`,
  ];
  if (rec.alternatives.length) {
    lines.push(``, `Alternatives:`, ...rec.alternatives.map((a) => `  - ${a}`));
  }
  lines.push(
    ``,
    `Risk:`,
    `  ${rec.risk}`,
    ``,
    `Default:`,
    `  ${rec.safeDefault}`,
    ``,
    `${rec.required ? 'Required' : 'Optional'}.`,
  );
  return lines.join('\n');
}
