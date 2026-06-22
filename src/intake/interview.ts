/**
 * Interactive intake / interview wizard.
 *
 * Before slicing, the system can interview the user to clarify the goal, success
 * and acceptance criteria, constraints, forbidden areas, risk, verification, and
 * the run policy (browser/GitHub/autonomy/human checkpoints/stop conditions).
 *
 * Three guarantees make this safe:
 *  1. The interview IMPROVES PLANNING ONLY. Everything it produces is folded into
 *     the Objective the deterministic planner already consumes. It never touches
 *     the verifier, never marks work done, and only ever STRENGTHENS safety
 *     (forbidden paths are unioned, verification checks are added, risk is raised
 *     to a floor — never lowered, never removed).
 *  2. Non-interactive / --auto never hangs. Missing answers become conservative,
 *     EXPLICITLY RECORDED assumptions; low-confidence ones are flagged.
 *  3. If a SAFETY-CRITICAL answer is missing and there is no safe default
 *     (e.g. a high-risk objective with no way to verify it), the interview BLOCKS
 *     and asks the user instead of inventing a plan.
 *
 * The engine has no stdin dependency: callers inject a {@link Prompter}. The CLI
 * supplies a readline-backed prompter (interactive) or none (auto); tests supply
 * a scripted prompter. Pure logic stays here and is unit-testable.
 */
import type { CheckSpec, Objective, Risk } from '../domain/schemas.js';
import { CheckSpecSchema } from '../domain/schemas.js';
import type { RawStory, NormalizeResult } from './normalize.js';
import { IntakeError } from '../domain/errors.js';

export const INTERVIEW_MODES = ['quick', 'standard', 'strict'] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export function isInterviewMode(v: string): v is InterviewMode {
  return (INTERVIEW_MODES as readonly string[]).includes(v);
}

/** A confidence-tagged assumption recorded when an answer was derived, not given. */
export interface InterviewAssumption {
  text: string;
  confidence: 'high' | 'low';
}

/** Structured answers gathered (or conservatively derived) by the interview. */
export interface InterviewAnswers {
  goal?: string;
  background?: string;
  successCriteria?: string[];
  acceptanceCriteria?: string[];
  nonGoals?: string[];
  userVisibleBehavior?: string;
  constraints?: string[];
  architecture?: string;
  forbiddenPaths?: string[];
  risk?: Risk;
  verificationCommands?: string[];
  mergePolicy?: string;
  browserVerification?: boolean;
  githubIntegration?: boolean;
  autonomous?: boolean;
  humanCheckpoints?: string[];
  stopConditions?: string[];
}

/** The validated output of an interview: answers + recorded assumptions. */
export interface InterviewOutcome {
  mode: InterviewMode;
  answers: InterviewAnswers;
  assumptions: InterviewAssumption[];
}

/** Minimal async question interface so the engine never imports stdin. */
export interface Prompter {
  /** Ask a free-text question; returns the raw answer (may be empty). */
  ask(question: string, opts?: { default?: string }): Promise<string>;
}

type QuestionType = 'text' | 'list' | 'yesno' | 'risk';

interface QuestionSpec {
  key: keyof InterviewAnswers;
  prompt: string;
  type: QuestionType;
  /** Smallest mode at which this question is asked (quick ⊂ standard ⊂ strict). */
  from: InterviewMode;
  /** Safety-critical: in --auto, blocks if no safe default exists for the context. */
  safetyCritical?: boolean;
}

/**
 * The question catalog, in interview order. `from` encodes the mode tier:
 *   quick → only the few critical-missing questions,
 *   standard → practical product/technical questions,
 *   strict → the full detailed set.
 */
export const QUESTION_CATALOG: readonly QuestionSpec[] = [
  { key: 'goal', prompt: 'What is the goal? (one sentence)', type: 'text', from: 'quick', safetyCritical: true },
  { key: 'acceptanceCriteria', prompt: 'Acceptance criteria — how do we know a slice is done? (comma-separated)', type: 'list', from: 'quick' },
  { key: 'verificationCommands', prompt: 'Verification commands to run (e.g. "npm test", "npm run build"; comma-separated)', type: 'list', from: 'quick', safetyCritical: true },
  { key: 'successCriteria', prompt: 'Overall success criteria for the objective (comma-separated)', type: 'list', from: 'standard' },
  { key: 'background', prompt: 'Background / context the agent should know', type: 'text', from: 'standard' },
  { key: 'userVisibleBehavior', prompt: 'User-visible behavior expected', type: 'text', from: 'standard' },
  { key: 'nonGoals', prompt: 'Non-goals / explicitly out of scope (comma-separated)', type: 'list', from: 'standard' },
  { key: 'constraints', prompt: 'Technical constraints (comma-separated)', type: 'list', from: 'standard' },
  { key: 'forbiddenPaths', prompt: 'Forbidden files/areas the agent must NOT touch (globs, comma-separated)', type: 'list', from: 'standard' },
  { key: 'risk', prompt: 'Risk level (low / medium / high)', type: 'risk', from: 'standard' },
  { key: 'browserVerification', prompt: 'Is browser/UI verification needed? (y/N)', type: 'yesno', from: 'standard' },
  { key: 'githubIntegration', prompt: 'Is GitHub / PR integration needed? (y/N)', type: 'yesno', from: 'standard' },
  { key: 'autonomous', prompt: 'Can this run autonomously without prompts? (y/N)', type: 'yesno', from: 'standard' },
  { key: 'architecture', prompt: 'Existing architecture the work must fit into', type: 'text', from: 'strict' },
  { key: 'mergePolicy', prompt: 'Deployment / merge policy', type: 'text', from: 'strict' },
  { key: 'humanCheckpoints', prompt: 'Human approval checkpoints required (comma-separated)', type: 'list', from: 'strict' },
  { key: 'stopConditions', prompt: 'Stop / blocker conditions (comma-separated)', type: 'list', from: 'strict' },
];

const HIGH_RISK_RE = /\b(auth|authentication|password|secret|payment|billing|crypto|security|migration|delete|drop|production|infra|deploy)\b/i;

function modeIncludes(mode: InterviewMode, from: InterviewMode): boolean {
  return RISK_RANK_MODE[mode] >= RISK_RANK_MODE[from];
}
const RISK_RANK_MODE: Record<InterviewMode, number> = { quick: 0, standard: 1, strict: 2 };

/** Context the engine needs to know what is "already answered" and what is safe. */
export interface InterviewContext {
  /** Base normalization of the input (objective + stories), if an input exists. */
  base?: NormalizeResult;
  /** Detected verification check ids/commands (from stack detection). */
  detectedChecks: string[];
  /** Whether the run is unattended (no prompting; conservative assumptions). */
  auto: boolean;
  /** Whether a TTY/prompter is available for interactive questions. */
  interactive: boolean;
}

/** Does the base input already provide a usable value for this field? */
function alreadyAnswered(key: keyof InterviewAnswers, ctx: InterviewContext): boolean {
  const obj = ctx.base?.objective;
  const stories = ctx.base?.stories ?? [];
  switch (key) {
    case 'goal':
      return Boolean(obj?.goal && obj.goal.trim() && !/^implement the (prd|document)$/i.test(obj.goal.trim()));
    case 'background':
      return Boolean(obj?.background && obj.background.trim());
    case 'nonGoals':
      return (obj?.nonGoals?.length ?? 0) > 0;
    case 'constraints':
      return (obj?.constraints?.length ?? 0) > 0;
    case 'successCriteria':
      return (obj?.successCriteria?.length ?? 0) > 0;
    case 'acceptanceCriteria':
      return stories.some((s) => s.acceptanceCriteria.length > 0);
    case 'verificationCommands':
      return ctx.detectedChecks.length > 0;
    default:
      return false;
  }
}

/**
 * The clarification questions to ask for a mode, given which fields are already
 * present. Used by GitHub triage to comment specific questions on unclear issues
 * instead of generating weak slices.
 */
export function clarificationPrompts(
  mode: InterviewMode,
  present: Partial<Record<keyof InterviewAnswers, boolean>> = {},
): string[] {
  return QUESTION_CATALOG.filter((q) => modeIncludes(mode, q.from))
    .filter((q) => !present[q.key])
    .map((q) => q.prompt);
}

/** Select the questions to ask for a mode, skipping ones already answered. */
export function selectQuestions(mode: InterviewMode, ctx: InterviewContext): QuestionSpec[] {
  return QUESTION_CATALOG.filter((q) => modeIncludes(mode, q.from)).filter((q) => {
    // quick only asks the critical-missing ones; never re-asks answered fields.
    if (alreadyAnswered(q.key, ctx)) return false;
    return true;
  });
}

/**
 * Run the interview. Interactive when a prompter is supplied and ctx.interactive
 * is true; otherwise derives conservative, recorded assumptions and never blocks
 * UNLESS a safety-critical answer is missing with no safe default.
 */
export async function conductInterview(
  mode: InterviewMode,
  ctx: InterviewContext,
  prompter?: Prompter,
  preset: InterviewAnswers = {},
): Promise<InterviewOutcome> {
  const answers: InterviewAnswers = { ...preset };
  const assumptions: InterviewAssumption[] = [];
  const interactive = ctx.interactive && !ctx.auto && prompter !== undefined;
  const questions = selectQuestions(mode, ctx);

  for (const q of questions) {
    // A preset answer (from --answers JSON) wins and is never re-asked.
    if (answers[q.key] !== undefined) continue;

    if (interactive) {
      const raw = (await prompter!.ask(q.prompt)).trim();
      if (raw) {
        assignAnswer(answers, q, raw, assumptions);
        continue;
      }
      // Empty interactive answer falls through to the conservative default below.
    }

    deriveDefault(q, ctx, answers, assumptions);
  }

  enforceSafety(mode, ctx, answers);
  return { mode, answers, assumptions };
}

function assignAnswer(answers: InterviewAnswers, q: QuestionSpec, raw: string, assumptions: InterviewAssumption[]): void {
  switch (q.type) {
    case 'list':
      (answers[q.key] as string[]) = splitList(raw);
      break;
    case 'yesno':
      (answers[q.key] as boolean) = /^y(es)?$/i.test(raw);
      break;
    case 'risk': {
      const r = raw.toLowerCase();
      if (r === 'low' || r === 'medium' || r === 'high') (answers[q.key] as Risk) = r;
      else assumptions.push({ text: `Ignored unrecognized risk '${raw}'; using planner heuristic.`, confidence: 'low' });
      break;
    }
    case 'text':
    default:
      (answers[q.key] as string) = raw;
      break;
  }
}

/** Conservative default + recorded assumption when an answer is absent. */
function deriveDefault(q: QuestionSpec, ctx: InterviewContext, answers: InterviewAnswers, assumptions: InterviewAssumption[]): void {
  const note = (text: string, confidence: 'high' | 'low' = 'low'): void => {
    assumptions.push({ text, confidence });
  };
  switch (q.key) {
    case 'goal':
      // Handled by enforceSafety / caller; never invented.
      break;
    case 'acceptanceCriteria':
      if (!alreadyAnswered('acceptanceCriteria', ctx)) {
        note('No explicit acceptance criteria; the agent must satisfy the goal end to end and pass all verification checks.');
      }
      break;
    case 'verificationCommands':
      if (ctx.detectedChecks.length > 0) {
        note(`Verification derived from the project: ${ctx.detectedChecks.join(', ')}.`, 'high');
      } else {
        note('No verification commands detected; relying on scope/secret/diff safety checks only.');
      }
      break;
    case 'successCriteria':
      note('No overall success criteria stated beyond the goal and verification checks.');
      break;
    case 'background':
      note('No background provided; the agent must infer context from the repository.');
      break;
    case 'userVisibleBehavior':
      note('No user-visible behavior specified.');
      break;
    case 'nonGoals':
      note('No non-goals specified; scope limited strictly to the stated goal.');
      break;
    case 'constraints':
      note('No additional technical constraints specified.');
      break;
    case 'forbiddenPaths':
      note('No extra forbidden paths specified; built-in secret/infra path protections still apply.', 'high');
      break;
    case 'risk':
      note('Risk left to the planner heuristic (raised, never lowered, by any explicit answer).', 'high');
      break;
    case 'architecture':
      note('Existing architecture not described; the agent must infer it from the repository.');
      break;
    case 'mergePolicy':
      answers.mergePolicy = 'Manual review required; agent-loop never auto-merges or deploys.';
      note('Merge policy defaulted to manual review — agent-loop never auto-merges/deploys.', 'high');
      break;
    case 'browserVerification':
      answers.browserVerification = false;
      note('Assumed no browser/UI verification required.');
      break;
    case 'githubIntegration':
      answers.githubIntegration = false;
      note('Assumed no GitHub/PR integration required.');
      break;
    case 'autonomous':
      answers.autonomous = ctx.auto;
      note(`Assumed autonomous=${ctx.auto} (from run mode).`, 'high');
      break;
    case 'humanCheckpoints':
      note('No human approval checkpoints requested; final completion still requires verified slices.');
      break;
    case 'stopConditions':
      note('Stop conditions defaulted to: any verification failure after retries, out-of-scope or secret-bearing changes.', 'high');
      break;
    default:
      break;
  }
}

/**
 * Block (throw) when a safety-critical answer is missing AND there is no safe
 * default for the context. The canonical case: a HIGH-RISK objective with NO way
 * to verify it (no detected checks and no provided verification commands) cannot
 * be planned safely unattended.
 */
function enforceSafety(_mode: InterviewMode, ctx: InterviewContext, answers: InterviewAnswers): void {
  const goal = answers.goal ?? ctx.base?.objective.goal ?? '';
  if (!goal.trim()) {
    throw new IntakeError('interview cannot proceed without a goal. Provide --idea/--prd or answer the goal question.');
  }

  // A user declaring a LOW risk must never suppress the heuristic high-risk signal:
  // the declared risk can only RAISE the effective risk, never lower it.
  const declaredRisk = answers.risk;
  const looksHighRisk = HIGH_RISK_RE.test(`${goal} ${ctx.base?.objective.background ?? ''}`);
  const isHighRisk = looksHighRisk || declaredRisk === 'high';
  const hasVerification = ctx.detectedChecks.length > 0 || (answers.verificationCommands?.length ?? 0) > 0;

  if (isHighRisk && !hasVerification) {
    throw new IntakeError(
      'safety-critical: this objective looks high-risk but has no verification commands. ' +
        'Re-run interactively (drop --auto) or provide verification (e.g. --interview and answer the ' +
        'verification question, or add `verification.commands` to .agent-loop/config.yml) before planning.',
    );
  }
}

// ---------------------------------------------------------------------------
// Applying an outcome to the Objective (planning improvement only — safety-safe)
// ---------------------------------------------------------------------------

export interface ApplyResult {
  objective: Objective;
  stories: RawStory[];
  /** Build hints derived from the interview (risk floor, extra slice notes). */
  riskFloor?: Risk;
  extraSliceNotes?: string;
  /** Assumption strings to record (confidence folded into the text). */
  assumptionLines: string[];
}

/**
 * Fold interview answers into the normalized Objective + stories. This ONLY
 * strengthens the plan:
 *  - forbidden paths are UNIONED into riskPolicy.globalForbiddenPaths,
 *  - verification commands are ADDED (deduped) — never removed,
 *  - risk becomes a FLOOR (slices may be raised, never lowered),
 *  - extra context becomes constraints / human-readable success criteria.
 * It never relaxes any existing safety field.
 */
export function applyInterview(base: NormalizeResult, outcome: InterviewOutcome): ApplyResult {
  const a = outcome.answers;
  // Deep-ish clone so we never mutate the caller's normalized result.
  const objective: Objective = JSON.parse(JSON.stringify(base.objective)) as Objective;
  let stories: RawStory[] = base.stories.map((s) => ({ ...s }));

  if (a.goal && a.goal.trim()) objective.goal = a.goal.trim();
  if (a.background && a.background.trim()) {
    objective.background = objective.background ? `${objective.background}\n\n${a.background.trim()}` : a.background.trim();
  }

  objective.nonGoals = unique([...objective.nonGoals, ...(a.nonGoals ?? [])]);

  const extraConstraints: string[] = [...(a.constraints ?? [])];
  if (a.userVisibleBehavior) extraConstraints.push(`User-visible behavior: ${a.userVisibleBehavior}`);
  if (a.architecture) extraConstraints.push(`Existing architecture: ${a.architecture}`);
  if (a.mergePolicy) extraConstraints.push(`Merge policy: ${a.mergePolicy}`);
  for (const c of a.stopConditions ?? []) extraConstraints.push(`Stop condition: ${c}`);
  objective.constraints = unique([...objective.constraints, ...extraConstraints]);

  // Human-readable success criteria (advisory; never gate the deterministic verifier).
  const humanCriteria = unique([...(a.successCriteria ?? []), ...(a.acceptanceCriteria ?? [])]);
  for (const desc of humanCriteria) {
    if (!objective.successCriteria.some((c) => c.description === desc)) {
      objective.successCriteria.push({ id: criterionId(objective.successCriteria.length), type: 'human', description: desc });
    }
  }

  // Verification commands → programmatic checks (ADD + dedupe). Strengthens only.
  if (a.verificationCommands?.length) {
    const existing = new Set(objective.verification.map((c) => commandKey(c.command)));
    let i = objective.verification.length;
    for (const cmd of a.verificationCommands) {
      const trimmed = cmd.trim();
      if (!trimmed) continue;
      const key = commandKey(trimmed);
      if (existing.has(key)) continue;
      existing.add(key);
      objective.verification.push(buildCheck(trimmed, i++));
    }
  }

  // Forbidden paths → UNION into the global forbidden set (applies to every slice).
  if (a.forbiddenPaths?.length) {
    objective.riskPolicy = {
      ...objective.riskPolicy,
      globalForbiddenPaths: unique([...objective.riskPolicy.globalForbiddenPaths, ...a.forbiddenPaths.filter(Boolean)]),
    };
  }

  // Acceptance criteria for an idea (no stories): synthesize a single story so the
  // slice carries them. We deliberately do NOT set the story's risk from the answer —
  // risk is applied as a FLOOR in buildPlan (maxRisk over the heuristic). That way a
  // declared risk can only ever RAISE a slice's risk, never lower the heuristic (so a
  // user can't tag a high-risk goal "low" to dodge risk-gated checks).
  if (stories.length === 0 && (a.acceptanceCriteria?.length ?? 0) > 0) {
    stories = [
      {
        title: truncate(objective.goal, 80),
        description: [objective.goal, objective.background].filter(Boolean).join('\n\n') || objective.goal,
        acceptanceCriteria: a.acceptanceCriteria!,
        ...(a.forbiddenPaths?.length ? { forbiddenPaths: a.forbiddenPaths } : {}),
      },
    ];
  } else if (a.forbiddenPaths?.length) {
    // Existing stories: only tighten forbidden paths; risk is raised via the floor.
    stories = stories.map((s) => ({
      ...s,
      forbiddenPaths: unique([...(s.forbiddenPaths ?? []), ...a.forbiddenPaths!]),
    }));
  }

  const notes: string[] = [];
  if (a.humanCheckpoints?.length) notes.push(`Human approval checkpoints: ${a.humanCheckpoints.join('; ')}`);
  if (a.browserVerification) notes.push('Browser/UI verification requested — configure browser.* in config and re-verify.');

  const assumptionLines = outcome.assumptions.map((x) =>
    x.confidence === 'low' ? `${x.text} (low confidence — verify)` : x.text,
  );
  // Record provenance so objective.md/assumptions.md explain how the plan was shaped.
  assumptionLines.unshift(`Plan shaped by an interview in '${outcome.mode}' mode.`);

  return {
    objective,
    stories,
    ...(a.risk ? { riskFloor: a.risk } : {}),
    ...(notes.length ? { extraSliceNotes: notes.join(' ') } : {}),
    assumptionLines,
  };
}

// --- helpers ----------------------------------------------------------------

function splitList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((s) => s && s.trim()))];
}

function commandKey(command: CheckSpec['command']): string {
  return Array.isArray(command) ? command.join(' ') : command;
}

function buildCheck(command: string, index: number): CheckSpec {
  return CheckSpecSchema.parse({ id: `iv-${index + 1}`, category: 'custom', command, expect: 'exit_zero' });
}

function criterionId(index: number): string {
  return `crit-iv-${index + 1}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
