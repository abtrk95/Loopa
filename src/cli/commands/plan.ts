/**
 * `agent-loop plan` — intake + planning, producing a validated, persisted plan.
 */
import { openSession } from '../../orchestrator/session.js';
import { createPlan } from '../../orchestrator/planning.js';
import { IntakeError } from '../../domain/errors.js';
import type { Plan } from '../../domain/schemas.js';
import type { ValidationReport } from '../../planner/validate.js';
import { resolveInput } from '../intake-input.js';
import { interviewRequested, interviewModeFromArgs, runInterviewPlan } from './interview.js';
import { cliConfigOverrides, flagBool, resolveRoot, type ParsedArgs } from '../args.js';

export async function cmdPlan(args: ParsedArgs): Promise<number> {
  // `plan --interview [mode]` runs the clarifying interview before slicing.
  if (interviewRequested(args)) {
    return runInterviewPlan(args, interviewModeFromArgs(args));
  }
  const root = resolveRoot(args);
  const session = openSession({ root, cliOverrides: cliConfigOverrides(args) });
  try {
    const input = await resolveInput(args, root);
    if (!input) {
      throw new IntakeError('no input provided. Use --idea "...", --prd <file>, --spec <file>, --issue <n>, or --stdin.');
    }
    const result = createPlan(session, { input, auto: flagBool(args, 'auto') || session.config.auto });
    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify(result.plan, null, 2) + '\n');
    } else {
      printPlanSummary(result.plan, result.validation);
      process.stdout.write(`\nPlan written to ${session.paths.planJson}\nRun it with: agent-loop run --auto\n`);
    }
    return 0;
  } finally {
    session.close();
  }
}

export function printPlanSummary(plan: Plan, validation: ValidationReport): void {
  const out = process.stdout;
  out.write(`Goal: ${plan.goal}\n`);
  out.write(`Slices: ${plan.slices.length}\n\n`);
  for (const s of plan.slices) {
    const deps = s.dependencies.length ? ` deps=[${s.dependencies.join(',')}]` : '';
    out.write(`  ${s.id}  [${s.risk}]${s.parallelSafe ? ' ∥' : ''} ${s.title}${deps}\n`);
    out.write(`        paths: ${s.allowedPaths.join(', ')}\n`);
    if (s.requiredChecks.length) out.write(`        checks: ${s.requiredChecks.join(', ')}\n`);
  }
  if (validation.warnings.length) {
    out.write(`\nWarnings:\n`);
    for (const w of validation.warnings) out.write(`  - ${w}\n`);
  }
}
