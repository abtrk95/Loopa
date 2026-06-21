/**
 * Plan validation. Runs before any execution. The schema (schemas.ts) already
 * guarantees structural invariants (id format, >=1 acceptance criterion, non-empty
 * allowedPaths, risk default); this layer adds cross-slice and policy checks that
 * a single-object schema can't express.
 */
import { PlanValidationError } from '../domain/errors.js';
import { PlanSchema, type Plan } from '../domain/schemas.js';
import { findGraphIssues } from './graph.js';
import { matchesAny } from '../git/scope.js';

export interface ValidationReport {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

export function validatePlan(plan: Plan): ValidationReport {
  const issues: string[] = [];
  const warnings: string[] = [];

  // Structural re-validation (defensive; cheap).
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      issues.push(`${i.path.join('.') || '(root)'}: ${i.message}`);
    }
    return { ok: false, issues, warnings };
  }

  // Graph: unique ids, valid deps, no cycles.
  for (const g of findGraphIssues(plan.slices)) {
    issues.push(`${g.kind}: ${g.detail}`);
  }

  const knownChecks = new Set(plan.verification.map((c) => c.id));
  for (const slice of plan.slices) {
    // Impossible path policy: every allowedPath also matched by a forbidden glob.
    const forbidden = [...slice.forbiddenPaths, ...plan.riskPolicy.globalForbiddenPaths];
    const allAllowedForbidden = slice.allowedPaths.every((a) => matchesAny(stripGlob(a), forbidden));
    if (slice.allowedPaths.length > 0 && allAllowedForbidden) {
      issues.push(`${slice.id}: every allowedPath is also forbidden — the slice can change nothing`);
    }
    // requiredChecks referencing neither a global check id nor a literal command.
    for (const rc of slice.requiredChecks) {
      const looksLikeCommand = rc.includes(' ') || rc.includes('/');
      if (!knownChecks.has(rc) && !looksLikeCommand) {
        warnings.push(`${slice.id}: requiredCheck '${rc}' is neither a known check id nor a command`);
      }
    }
    // Reasonable slice size heuristic.
    if (slice.acceptanceCriteria.length > 12) {
      warnings.push(`${slice.id}: ${slice.acceptanceCriteria.length} acceptance criteria — consider splitting`);
    }
  }

  // At least one slice must be runnable (no slice can have all of its deps missing,
  // already caught; but a fully-cyclic plan would have zero eligible).
  const hasRoot = plan.slices.some((s) => s.dependencies.length === 0);
  if (!hasRoot && plan.slices.length > 0) {
    issues.push('no slice has zero dependencies — nothing can start');
  }

  return { ok: issues.length === 0, issues, warnings };
}

/** Assert validity, throwing a typed error with all issues. */
export function assertValidPlan(plan: Plan): ValidationReport {
  const report = validatePlan(plan);
  if (!report.ok) {
    throw new PlanValidationError(`plan failed validation (${report.issues.length} issue(s))`, report.issues);
  }
  return report;
}

function stripGlob(glob: string): string {
  // Represent a glob by a concrete-ish sample path for forbidden-matching.
  return glob.replace(/\*\*/g, 'x').replace(/\*/g, 'x').replace(/\?/g, 'x');
}
