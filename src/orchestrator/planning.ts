/**
 * Planning phase wiring: intake → planner → validation → persistence → events.
 * Produces a validated, persisted Plan and a fresh run id, and records the plan
 * lifecycle in the event store (RUN_CREATED → OBJECTIVE_CREATED → PLAN_CREATED →
 * PLAN_VALIDATED). No execution happens here.
 */
import { newRunId } from '../domain/ids.js';
import type { Session } from './session.js';
import { savePlan, saveObjective, saveRunMeta } from './session.js';
import { normalizeInput, type RawInput } from '../intake/normalize.js';
import { buildPlan } from '../planner/plan.js';
import { assertValidPlan, type ValidationReport } from '../planner/validate.js';
import type { Plan, Objective } from '../domain/schemas.js';

export interface CreatePlanOptions {
  input: RawInput;
  defaultBranch?: string | undefined;
  auto?: boolean;
}

export interface CreatePlanResult {
  runId: string;
  plan: Plan;
  objective: Objective;
  validation: ValidationReport;
}

export function createPlan(session: Session, opts: CreatePlanOptions): CreatePlanResult {
  const { normalizeOptions } = buildNormalizeOptions(session, opts);
  const { objective, stories } = normalizeInput(opts.input, normalizeOptions);

  const createdAt = session.clock.iso();
  const plan = buildPlan(objective, stories, {
    createdAt,
    branch: deriveBranch(session, objective.goal),
  });
  const validation = assertValidPlan(plan);

  // Persist durable, human-meaningful artifacts.
  saveObjective(session.paths, objective);
  savePlan(session.paths, plan);

  const runId = newRunId();
  saveRunMeta(session.paths, { runId, planId: plan.planId, createdAt });

  // Record the plan lifecycle in the event store, driving the run state machine
  // CREATED → INTAKE → PLANNING → PLAN_READY so the projection stays coherent.
  const emit = session.store.append.bind(session.store);
  emit({ runId, type: 'RUN_CREATED', source: 'orchestrator', payload: { goal: objective.goal, planId: plan.planId } });
  emit({ runId, type: 'RUN_STATE_CHANGED', source: 'orchestrator', payload: { from: 'CREATED', to: 'INTAKE' } });
  emit({ runId, type: 'OBJECTIVE_CREATED', source: 'intake', payload: { goal: objective.goal, source: objective.source.kind } });
  for (const assumption of objective.assumptions) {
    emit({ runId, type: 'ASSUMPTION_RECORDED', source: 'intake', payload: { text: assumption } });
  }
  emit({ runId, type: 'RUN_STATE_CHANGED', source: 'orchestrator', payload: { from: 'INTAKE', to: 'PLANNING' } });
  emit({
    runId,
    type: 'PLAN_CREATED',
    source: 'planner',
    payload: {
      planId: plan.planId,
      goal: plan.goal,
      branch: deriveBranch(session, plan.goal),
      totalSlices: plan.slices.length,
      sliceIds: plan.slices.map((s) => s.id),
      sliceTitles: Object.fromEntries(plan.slices.map((s) => [s.id, s.title])),
    },
  });
  emit({ runId, type: 'RUN_STATE_CHANGED', source: 'orchestrator', payload: { from: 'PLANNING', to: 'PLAN_READY' } });
  emit({
    runId,
    type: 'PLAN_VALIDATED',
    source: 'planner',
    payload: { issues: validation.issues, warnings: validation.warnings },
  });

  return { runId, plan, objective, validation };
}

function buildNormalizeOptions(session: Session, opts: CreatePlanOptions): {
  normalizeOptions: Parameters<typeof normalizeInput>[1];
} {
  return {
    normalizeOptions: {
      root: session.root,
      ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
      auto: opts.auto ?? session.config.auto,
    },
  };
}

export function deriveBranch(session: Session, goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run';
  return `${session.config.git.branchPrefix}${slug}`;
}
