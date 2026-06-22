/**
 * `agent-loop interview` and the `plan --interview` flow.
 *
 * The interview clarifies the objective BEFORE slicing, then runs the same
 * deterministic planner. It improves plan quality only: completion is still
 * `verified-completed / total` slices and the verifier is untouched.
 */
import { readFileSync } from 'node:fs';
import { openSession, type Session } from '../../orchestrator/session.js';
import { createPlan } from '../../orchestrator/planning.js';
import { detectStack } from '../../intake/detect.js';
import { normalizeInput, type RawInput, type NormalizeResult } from '../../intake/normalize.js';
import {
  conductInterview,
  isInterviewMode,
  INTERVIEW_MODES,
  type InterviewAnswers,
  type InterviewContext,
  type InterviewMode,
  type InterviewOutcome,
} from '../../intake/interview.js';
import { IntakeError } from '../../domain/errors.js';
import { ReadlinePrompter, canPromptInteractively } from '../prompter.js';
import { resolveInput } from '../intake-input.js';
import { printPlanSummary } from './plan.js';
import { cliConfigOverrides, flagBool, flagStr, resolveRoot, type ParsedArgs } from '../args.js';

/** Read the requested interview mode from flags (defaults to `standard`). */
export function interviewModeFromArgs(args: ParsedArgs, positional?: string, fallback: InterviewMode = 'standard'): InterviewMode {
  const raw = flagStr(args, 'interview') ?? flagStr(args, 'mode') ?? positional;
  if (raw === undefined) return fallback;
  if (!isInterviewMode(raw)) {
    throw new IntakeError(`interview mode must be one of: ${INTERVIEW_MODES.join(', ')} (got '${raw}')`);
  }
  return raw;
}

/** Is `--interview` present at all (boolean or with a value)? */
export function interviewRequested(args: ParsedArgs): boolean {
  return flagBool(args, 'interview');
}

/** Load preset answers from a JSON file (--answers), coercing each known key to its
 * expected type so a malformed file degrades gracefully instead of crashing. Unknown
 * keys and ill-typed values are dropped. */
function loadPresetAnswers(path: string): InterviewAnswers {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new IntakeError(`cannot read --answers file '${path}': ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IntakeError(`--answers file '${path}' must be a JSON object of interview answers`);
  }
  return coerceAnswers(raw as Record<string, unknown>);
}

const LIST_KEYS = ['successCriteria', 'acceptanceCriteria', 'nonGoals', 'constraints', 'forbiddenPaths', 'verificationCommands', 'humanCheckpoints', 'stopConditions'] as const;
const TEXT_KEYS = ['goal', 'background', 'userVisibleBehavior', 'architecture', 'mergePolicy'] as const;
const BOOL_KEYS = ['browserVerification', 'githubIntegration', 'autonomous'] as const;

function toList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function coerceAnswers(raw: Record<string, unknown>): InterviewAnswers {
  const out: InterviewAnswers = {};
  for (const k of LIST_KEYS) {
    const list = toList(raw[k]);
    if (list && list.length) (out[k] as string[]) = list;
  }
  for (const k of TEXT_KEYS) {
    if (typeof raw[k] === 'string' && raw[k]) (out[k] as string) = raw[k] as string;
  }
  for (const k of BOOL_KEYS) {
    if (typeof raw[k] === 'boolean') (out[k] as boolean) = raw[k] as boolean;
  }
  if (raw['risk'] === 'low' || raw['risk'] === 'medium' || raw['risk'] === 'high') out.risk = raw['risk'];
  return out;
}

/**
 * Conduct the interview and return the outcome plus the effective input (the
 * interview can supply the goal when no input was given). Reused by the
 * `interview`/`plan --interview` commands and by `github import/run-issue`.
 */
export async function gatherInterview(
  session: Session,
  args: ParsedArgs,
  mode: InterviewMode,
  input: RawInput | undefined,
): Promise<{ outcome: InterviewOutcome; input: RawInput }> {
  const root = session.root;
  const auto = flagBool(args, 'auto') || session.config.auto;
  const base: NormalizeResult | undefined = input ? normalizeInput(input, { root, auto }) : undefined;
  const detectedChecks = detectStack(root).verification.map((c) => c.id);
  const interactive = canPromptInteractively();
  const ctx: InterviewContext = { ...(base ? { base } : {}), detectedChecks, auto, interactive };

  const presetPath = flagStr(args, 'answers');
  const preset = presetPath ? loadPresetAnswers(presetPath) : {};
  const prompter = interactive && !auto ? new ReadlinePrompter() : undefined;

  if (!input && !interactive && !auto && Object.keys(preset).length === 0) {
    throw new IntakeError('interview needs a goal: run in a terminal, pass --idea/--prd, or supply --answers <file>.');
  }

  const outcome = await conductInterview(mode, ctx, prompter, preset);
  const effectiveInput: RawInput = input ?? { kind: 'idea', text: requireGoal(outcome) };
  return { outcome, input: effectiveInput };
}

export async function cmdInterview(args: ParsedArgs): Promise<number> {
  const mode = interviewModeFromArgs(args, args.positionals[0]);
  return runInterviewPlan(args, mode);
}

/** Shared flow for `interview` and `plan --interview`. */
export async function runInterviewPlan(args: ParsedArgs, mode: InterviewMode): Promise<number> {
  const root = resolveRoot(args);
  const session = openSession({ root, cliOverrides: cliConfigOverrides(args) });
  try {
    const input = await resolveInput(args, root);
    const auto = flagBool(args, 'auto') || session.config.auto;
    const { outcome, input: effectiveInput } = await gatherInterview(session, args, mode, input);
    const result = createPlan(session, { input: effectiveInput, auto, interview: outcome });

    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify(result.plan, null, 2) + '\n');
    } else {
      process.stdout.write(`Interview (${mode}) complete. Recorded ${outcome.assumptions.length} assumption(s).\n\n`);
      printPlanSummary(result.plan, result.validation);
      process.stdout.write(
        `\nObjective:   ${session.paths.objectiveMd}\n` +
          `Assumptions: ${session.paths.assumptionsMd}\n` +
          `Plan:        ${session.paths.planJson}\n` +
          `Edit the plan if needed, then run it with: agent-loop run --auto\n`,
      );
    }
    return 0;
  } finally {
    session.close();
  }
}

function requireGoal(outcome: InterviewOutcome): string {
  const goal = outcome.answers.goal?.trim();
  if (!goal) {
    throw new IntakeError('no goal captured by the interview; provide --idea/--prd or answer the goal question.');
  }
  return goal;
}
