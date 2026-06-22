/**
 * `agent-loop interview` and the `plan --interview` flow.
 *
 * The interview clarifies the objective BEFORE slicing, then runs the same
 * deterministic planner. It improves plan quality only: completion is still
 * `verified-completed / total` slices and the verifier is untouched.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { openSession, reconfigureSession, type Session } from '../../orchestrator/session.js';
import { createPlan } from '../../orchestrator/planning.js';
import { detectStack } from '../../intake/detect.js';
import { normalizeInput, type RawInput, type NormalizeResult } from '../../intake/normalize.js';
import {
  conductInterview,
  isInterviewMode,
  INTERVIEW_MODES,
  selectQuestions,
  selectOrchestrationQuestions,
  applyOrchestration,
  type InterviewAnswers,
  type InterviewContext,
  type InterviewMode,
  type InterviewOutcome,
  type OrchestrationApply,
} from '../../intake/interview.js';
import {
  buildRecommendations,
  computeSignals,
  type ProviderInfo,
  type RecommendInputs,
  type Recommendation,
} from '../../intake/recommend.js';
import { deepMerge } from '../../config/load.js';
import { CommandProvider, presetSpec, PRESET_PROVIDER_IDS } from '../../providers/command.js';
import { atomicWrite } from '../../util/fs.js';
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

export interface GatherResult {
  outcome: InterviewOutcome;
  input: RawInput;
  /** Config override derived from the orchestration answers (strengthen-only). */
  orchestration: OrchestrationApply;
  /** The recommendations computed for this interview (for display). */
  recommendations: Recommendation[];
}

/**
 * Conduct the interview and return the outcome plus the effective input (the
 * interview can supply the goal when no input was given). Reused by the
 * `interview`/`plan --interview` commands and by `github import/run-issue`.
 *
 * Adds per-question recommendations and agent/model orchestration questions. The
 * orchestration answers become a config override that is applied IN-MEMORY to the
 * session (so a single command runs with the chosen providers/concurrency) and,
 * with `--write-config`, persisted to `.agent-loop/config.yml`.
 */
export async function gatherInterview(
  session: Session,
  args: ParsedArgs,
  mode: InterviewMode,
  input: RawInput | undefined,
  opts: { githubRequested?: boolean } = {},
): Promise<GatherResult> {
  const root = session.root;
  const auto = flagBool(args, 'auto') || session.config.auto;
  const base: NormalizeResult | undefined = input ? normalizeInput(input, { root, auto }) : undefined;
  const detected = detectStack(root);
  const detectedChecks = detected.verification.map((c) => c.id);
  const interactive = canPromptInteractively();
  const ctx: InterviewContext = { ...(base ? { base } : {}), detectedChecks, auto, interactive };

  const presetPath = flagStr(args, 'answers');
  const preset = presetPath ? loadPresetAnswers(presetPath) : {};
  const acceptRecommended = flagBool(args, 'accept-recommended');
  const includeOrchestration = !flagBool(args, 'no-orchestration');
  const prompter = interactive && !auto ? new ReadlinePrompter() : undefined;

  if (!input && !interactive && !auto && Object.keys(preset).length === 0 && !acceptRecommended) {
    throw new IntakeError('interview needs a goal: run in a terminal, pass --idea/--prd, or supply --answers <file>.');
  }

  // Build the recommendation inputs (detected stack, git state, providers, config).
  const recInputs = await buildRecommendInputs(session, mode, base, input, detected, auto, opts.githubRequested);
  const questions = [
    ...selectQuestions(mode, ctx),
    ...(includeOrchestration ? selectOrchestrationQuestions(mode, ctx) : []),
  ];
  const recMap = buildRecommendations(questions.map((q) => ({ key: q.key, prompt: q.prompt })), recInputs);

  const outcome = await conductInterview(mode, ctx, prompter, preset, {
    recommendations: recMap,
    acceptRecommended,
    includeOrchestration,
  });

  // Fold accepted orchestration answers into config (strengthen-only).
  const orchestration = applyOrchestration(outcome.answers, { highRisk: recInputs.signals.highRisk });
  if (Object.keys(orchestration.override).length) {
    const merged = deepMerge(cliConfigOverrides(args) as Record<string, unknown>, orchestration.override);
    reconfigureSession(session, merged);
    if (flagBool(args, 'write-config')) persistConfigOverride(session, orchestration.override);
  }

  const effectiveInput: RawInput = input ?? { kind: 'idea', text: requireGoal(outcome) };
  return { outcome, input: effectiveInput, orchestration, recommendations: [...recMap.values()] };
}

/** Assemble the inputs the recommendation engine reasons over. */
async function buildRecommendInputs(
  session: Session,
  mode: InterviewMode,
  base: NormalizeResult | undefined,
  input: RawInput | undefined,
  detected: ReturnType<typeof detectStack>,
  auto: boolean,
  githubRequested?: boolean,
): Promise<RecommendInputs> {
  const goalText = [base?.objective.goal, base?.objective.background, input?.text].filter(Boolean).join('\n') || (input?.text ?? '');
  const detectedCommands = detected.verification.map((c) => renderCommand(c.command));
  const packageScripts = readPackageScripts(session.root);

  let gitClean = true;
  let gitBranch: string | undefined;
  try {
    if (await session.git.isRepo()) {
      gitClean = await session.git.isClean();
      gitBranch = await session.git.currentBranch();
    }
  } catch {
    // best-effort; absence of git state never blocks the interview.
  }

  const providers = await collectProviderInfo(session);
  const signals = computeSignals({
    goalText,
    stack: detected.stack,
    packageManager: detected.packageManager,
    packageScripts,
    detectedChecks: detected.verification.map((c) => c.id),
    detectedCommands,
    gitClean,
    gitBranch,
    ...(githubRequested !== undefined ? { githubRequested } : {}),
  });

  return { mode, goalText, signals, providers, config: session.config, auto };
}

async function collectProviderInfo(session: Session): Promise<ProviderInfo[]> {
  const out: ProviderInfo[] = [];
  const seen = new Set<string>();
  const probe = async (adapter: { id: string; health(): Promise<{ ok: boolean }>; capabilities(): { roles: readonly string[] } }): Promise<void> => {
    if (seen.has(adapter.id)) return;
    seen.add(adapter.id);
    let installed = false;
    try {
      installed = (await adapter.health()).ok;
    } catch {
      installed = false;
    }
    out.push({ id: adapter.id, installed, roles: [...adapter.capabilities().roles] });
  };

  for (const adapter of session.registry.all()) await probe(adapter);
  // Also probe the known real-CLI presets even when config still defaults to `fake`,
  // so the interview can recommend an installed provider (e.g. claude) that the user
  // has not configured yet.
  for (const id of PRESET_PROVIDER_IDS) {
    if (seen.has(id)) continue;
    const spec = presetSpec(id);
    if (spec) await probe(new CommandProvider(spec, session.pm));
  }
  return out;
}

function renderCommand(command: string | string[]): string {
  return Array.isArray(command) ? command.join(' ') : command;
}

function readPackageScripts(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { scripts?: Record<string, unknown> };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

/** Merge the orchestration override into `.agent-loop/config.yml` (never clobbers). */
function persistConfigOverride(session: Session, override: Record<string, unknown>): void {
  const path = session.paths.configYml;
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const merged = deepMerge(existing, override);
  atomicWrite(path, stringifyYaml(merged));
  process.stdout.write(`Wrote orchestration choices to ${path}\n`);
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
    const gathered = await gatherInterview(session, args, mode, input);
    const result = createPlan(session, { input: gathered.input, auto, interview: gathered.outcome });

    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify(result.plan, null, 2) + '\n');
    } else {
      process.stdout.write(`Interview (${mode}) complete. Recorded ${gathered.outcome.assumptions.length} assumption(s).\n\n`);
      printPlanSummary(result.plan, result.validation);
      printOrchestrationSummary(session, gathered, args);
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

/**
 * Print the agent/model orchestration decisions: the resolved roles/concurrency,
 * any follow-up notes, and the equivalent `run` flags. Shown after the plan so a
 * user sees exactly which providers/concurrency the run will use.
 */
export function printOrchestrationSummary(session: Session, gathered: GatherResult, args: ParsedArgs): void {
  const out = process.stdout;
  const c = session.config;
  const a = gathered.outcome.answers;
  const touched =
    Object.keys(gathered.orchestration.override).length > 0 ||
    a.plannerProvider !== undefined ||
    a.workerProviders !== undefined ||
    a.concurrency !== undefined;
  if (!touched && gathered.recommendations.every((r) => r.section !== 'orchestration')) return;

  out.write(`\nOrchestration (verifier remains authoritative; AI roles can never override it):\n`);
  out.write(`  planner:     ${refStr(c.roles.planner)}\n`);
  out.write(`  workers:     ${c.roles.workers.map(refStr).join(', ')}\n`);
  out.write(`  reviewer:    ${c.roles.reviewer ? refStr(c.roles.reviewer) : c.roles.reviewers.length ? c.roles.reviewers.map(refStr).join(', ') : '(none — verifier only)'}\n`);
  out.write(`  fixer:       ${'strategy' in c.roles.fixer ? c.roles.fixer.strategy : refStr(c.roles.fixer)}\n`);
  out.write(`  concurrency: ${c.execution.concurrency}${c.execution.concurrency > 1 ? ' (parallel; overlapping scopes still serialize)' : ' (sequential)'}\n`);
  out.write(`  fallback:    ${c.routing.fallbackOrder.length ? c.routing.fallbackOrder.join(' → ') : '(none)'}  switch-on-retry: ${c.routing.switchProviderOnRetry}\n`);
  out.write(`  consensus:   ${c.routing.reviewerConsensus}  browser: ${c.browser.enabled ? (c.browser.required ? 'required' : 'advisory') : 'off'}  github: ${c.github.enabled ? 'on' : 'off'}  auto: ${c.auto}\n`);
  for (const note of gathered.orchestration.notes) out.write(`  note: ${note}\n`);
  if (!flagBool(args, 'write-config')) {
    out.write(`  (these are applied to THIS run; pass --write-config to persist to .agent-loop/config.yml)\n`);
  }
}

function refStr(ref: { provider: string; model?: string | undefined }): string {
  return ref.model ? `${ref.provider}:${ref.model}` : ref.provider;
}

function requireGoal(outcome: InterviewOutcome): string {
  const goal = outcome.answers.goal?.trim();
  if (!goal) {
    throw new IntakeError('no goal captured by the interview; provide --idea/--prd or answer the goal question.');
  }
  return goal;
}
