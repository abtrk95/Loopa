/**
 * Planner: convert a normalized Objective (+ optional structured stories) into a
 * canonical Plan of small, independently verifiable slices.
 *
 * Deterministic by design: when the input already contains stories (a PRD), each
 * story maps to a slice with no model in the loop — so `plan` is reproducible and
 * testable. When only an idea is given, a conservative single implementation slice
 * is produced (and the assumption is recorded). A real planner provider can be
 * used to generate richer slicing via `slicesFromProviderOutput`.
 */
import { sliceId as fmtSliceId, newPlanId } from '../domain/ids.js';
import { PlanSchema, type Objective, type Plan, type Slice, type Risk } from '../domain/schemas.js';
import type { RawStory } from '../intake/normalize.js';

export interface BuildPlanOptions {
  planId?: string;
  createdAt: string;
  branch: string;
  /** Lower bound on every slice's risk (interview-supplied). Raises, never lowers. */
  riskFloor?: Risk;
  /** Extra note appended to every slice (e.g. human-checkpoint provenance). */
  extraSliceNotes?: string;
}

export function buildPlan(objective: Objective, stories: RawStory[], opts: BuildPlanOptions): Plan {
  const checkIds = objective.verification.map((c) => c.id);
  const slices: Slice[] = stories.length > 0 ? slicesFromStories(stories, checkIds) : [conservativeSlice(objective, checkIds)];

  const shaped = slices.map((s) => ({
    ...s,
    ...(opts.riskFloor ? { risk: maxRisk(s.risk, opts.riskFloor) } : {}),
    ...(opts.extraSliceNotes ? { notes: [s.notes, opts.extraSliceNotes].filter(Boolean).join(' ') } : {}),
  }));

  const plan = {
    ...objective,
    planId: opts.planId ?? newPlanId(),
    createdAt: opts.createdAt,
    slices: shaped,
  };
  // Parse through the schema so all defaults are applied and the result is valid.
  return PlanSchema.parse(plan);
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

function slicesFromStories(stories: RawStory[], checkIds: string[]): Slice[] {
  const ordered = [...stories].sort(
    (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
  );
  // Map original story ids → generated slice ids for dependency resolution.
  const idMap = new Map<string, string>();
  ordered.forEach((s, i) => {
    const id = fmtSliceId(i);
    if (s.id) idMap.set(s.id, id);
  });

  return ordered.map((story, i) => {
    const id = fmtSliceId(i);
    const dependencies = (story.dependencies ?? [])
      .map((d) => idMap.get(d))
      .filter((d): d is string => typeof d === 'string');
    const acceptanceCriteria =
      story.acceptanceCriteria.length > 0 ? story.acceptanceCriteria : [`Implement "${story.title}" as described.`];
    return {
      id,
      title: story.title,
      description: story.description || story.title,
      acceptanceCriteria,
      dependencies,
      allowedPaths: story.allowedPaths && story.allowedPaths.length > 0 ? story.allowedPaths : ['**'],
      forbiddenPaths: story.forbiddenPaths ?? [],
      requiredChecks: checkIds,
      risk: story.risk ?? heuristicRisk(`${story.title} ${story.description}`),
      preferredRole: 'worker' as const,
      parallelSafe: story.parallelSafe ?? false,
    };
  });
}

function conservativeSlice(objective: Objective, checkIds: string[]): Slice {
  const acceptance =
    objective.successCriteria.length > 0
      ? objective.successCriteria.map((c) => c.description)
      : ['Implement the stated goal end to end.'];
  return {
    id: fmtSliceId(0),
    title: truncate(`Implement: ${objective.goal}`, 80),
    description: [objective.goal, objective.background].filter(Boolean).join('\n\n'),
    acceptanceCriteria: acceptance,
    dependencies: [],
    allowedPaths: ['**'],
    forbiddenPaths: [],
    requiredChecks: checkIds,
    risk: heuristicRisk(`${objective.goal} ${objective.background}`),
    preferredRole: 'worker',
    parallelSafe: false,
    notes: 'Single conservative slice derived from an unstructured idea. Provide a PRD or a real planner provider for finer slicing.',
  };
}

const HIGH_RISK = /\b(auth|authentication|password|secret|payment|billing|crypto|security|migration|delete|drop|production|infra|deploy)\b/i;
const MED_RISK = /\b(database|schema|api|endpoint|config|permission|role|upload)\b/i;

export function heuristicRisk(text: string): Risk {
  if (HIGH_RISK.test(text)) return 'high';
  if (MED_RISK.test(text)) return 'medium';
  return 'low';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
