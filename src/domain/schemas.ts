/**
 * Canonical schemas for agent-loop.
 *
 * These zod schemas are the single source of truth for the shapes that flow
 * through the system: the normalized Objective, the executable Plan and its
 * Slices, command/verification specs, and the (advisory) reviewer verdict.
 *
 * The schemas double as static types via `z.infer`, so there is exactly one
 * definition per concept and validation happens at every system boundary.
 */
import { z } from 'zod';

/** Bump when the on-disk plan/objective shape changes incompatibly. */
export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const RiskSchema = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof RiskSchema>;

export const RoleSchema = z.enum([
  'planner',
  'worker',
  'reviewer',
  'fixer',
  'judge',
  'browser',
]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * A command is either a human-friendly line ("npm run typecheck") or an explicit
 * argv array (["npm", "run", "typecheck"]). Both are executed WITHOUT a shell:
 * string forms are tokenized by a quote-aware splitter (see process/command.ts),
 * so neither form is vulnerable to shell injection.
 */
export const CommandSpecSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export const CheckCategorySchema = z.enum([
  'typecheck',
  'lint',
  'test',
  'build',
  'custom',
]);
export type CheckCategory = z.infer<typeof CheckCategorySchema>;

export const ExpectSchema = z.enum(['exit_zero', 'exit_nonzero', 'stdout_contains']);
export type Expect = z.infer<typeof ExpectSchema>;

/** A deterministic, re-runnable check definition (global or per-slice). */
export const CheckSpecSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    category: CheckCategorySchema.default('custom'),
    command: CommandSpecSchema,
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    expect: ExpectSchema.default('exit_zero'),
    /** Required when expect === 'stdout_contains'. */
    contains: z.string().optional(),
  })
  .strict()
  .refine((c) => c.expect !== 'stdout_contains' || (c.contains?.length ?? 0) > 0, {
    message: "checks with expect 'stdout_contains' must set `contains`",
    path: ['contains'],
  });
export type CheckSpec = z.infer<typeof CheckSpecSchema>;

/**
 * Typed success criterion (the verification taxonomy, clean-roomed from the
 * Looper skill): programmatic (deterministic), judge (model verdict), or human.
 * Only `programmatic` criteria gate completion deterministically.
 */
export const CriterionSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['programmatic', 'judge', 'human']),
    description: z.string().min(1),
    // programmatic
    check: CommandSpecSchema.optional(),
    expect: ExpectSchema.optional(),
    contains: z.string().optional(),
    // judge
    rubric: z.string().optional(),
    // human
    prompt: z.string().optional(),
  })
  .strict()
  .refine((c) => c.type !== 'programmatic' || c.check !== undefined, {
    message: 'programmatic criteria must define a `check` command',
    path: ['check'],
  });
export type Criterion = z.infer<typeof CriterionSchema>;

// ---------------------------------------------------------------------------
// Risk policy & repository info
// ---------------------------------------------------------------------------

export const RiskPolicySchema = z
  .object({
    /** Hard ceiling on added lines per slice diff. */
    maxDiffLines: z.number().int().positive().default(800),
    /** Allow changes to dependency manifests (package.json, go.mod, …). */
    allowDependencyChanges: z.boolean().default(true),
    /** Allow lockfile changes (package-lock.json, pnpm-lock.yaml, …). */
    allowLockfileChanges: z.boolean().default(true),
    /** Slices at or above this risk require a passing reviewer before commit. */
    requireReviewAtOrAbove: RiskSchema.optional(),
    /** Globs forbidden for every slice (in addition to per-slice forbiddenPaths).
     * Conventional secret-bearing locations are blocked by default; the content
     * secret-scanner is heuristic (pattern-based) and is a second line of defense,
     * NOT a guarantee — path policy is the deterministic guard. Extend/override via
     * config `riskPolicy.globalForbiddenPaths` (your globs are unioned with these). */
    globalForbiddenPaths: z.array(z.string()).default([
      '.env',
      '.env.*',
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/*.key',
      '**/*.p12',
      '**/*.pfx',
      '**/id_rsa',
      '**/id_dsa',
      '**/id_ecdsa',
      '**/id_ed25519',
      '**/.git-credentials',
      '**/.pgpass',
      '**/.netrc',
      'secrets/**',
      '**/secrets/**',
      'credentials/**',
      '**/credentials/**',
      '.git/**',
      'infra/production/**',
    ]),
  })
  .strict();
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

export const RepositorySchema = z
  .object({
    root: z.string().min(1),
    defaultBranch: z.string().default('main'),
    /** Detected stack hints, e.g. ["node", "typescript", "vitest"]. */
    stack: z.array(z.string()).default([]),
    packageManager: z.string().optional(),
  })
  .strict();
export type Repository = z.infer<typeof RepositorySchema>;

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------

export const SliceSchema = z
  .object({
    id: z.string().regex(/^S-\d{3,}$/, 'slice id must look like S-001'),
    title: z.string().min(1),
    description: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1, 'each slice needs >=1 acceptance criterion'),
    dependencies: z.array(z.string()).default([]),
    allowedPaths: z.array(z.string().min(1)).min(1, 'each slice must declare allowedPaths'),
    forbiddenPaths: z.array(z.string()).default([]),
    /**
     * Checks that must pass for this slice. Each entry is either the id of a
     * global check (see Plan.verification) or a literal command line.
     */
    requiredChecks: z.array(z.string().min(1)).default([]),
    risk: RiskSchema.default('low'),
    preferredRole: RoleSchema.default('worker'),
    parallelSafe: z.boolean().default(false),
    /** Optional notes carried from intake (assumptions specific to this slice). */
    notes: z.string().optional(),
  })
  .strict();
export type Slice = z.infer<typeof SliceSchema>;

// ---------------------------------------------------------------------------
// Objective (normalized intake output, minus slices)
// ---------------------------------------------------------------------------

export const ObjectiveSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    goal: z.string().min(1),
    background: z.string().default(''),
    successCriteria: z.array(CriterionSchema).default([]),
    constraints: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()).default([]),
    repository: RepositorySchema,
    /** Global verification commands run during FINAL_VERIFYING and as defaults. */
    verification: z.array(CheckSpecSchema).default([]),
    riskPolicy: RiskPolicySchema.default({}),
    /** Human-readable final completion criteria (also encoded as successCriteria). */
    finalCompletionCriteria: z.array(z.string()).default([]),
    source: z
      .object({
        kind: z.enum(['idea', 'prd-md', 'prd-json', 'spec', 'readme', 'issue', 'stdin', 'objective']),
        ref: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type Objective = z.infer<typeof ObjectiveSchema>;

// ---------------------------------------------------------------------------
// Plan (canonical executable spec = Objective + ordered slices)
// ---------------------------------------------------------------------------

export const PlanSchema = ObjectiveSchema.extend({
  planId: z.string().min(1),
  createdAt: z.string(), // ISO timestamp, stamped by caller (no Date.now in core fns)
  slices: z.array(SliceSchema).min(1, 'a plan needs at least one slice'),
}).strict();
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// Reviewer verdict (advisory; validated, never authoritative over the verifier)
// ---------------------------------------------------------------------------

export const ReviewFindingSchema = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    file: z.string().optional(),
    line: z.number().int().nonnegative().optional(),
    description: z.string().min(1),
    requiredAction: z.string().optional(),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewVerdictSchema = z
  .object({
    verdict: z.enum(['pass', 'changes_requested', 'blocked']),
    findings: z.array(ReviewFindingSchema).default([]),
    summary: z.string().optional(),
  })
  .strict();
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse + validate a Plan from untrusted JSON, with helpful errors. */
export function parsePlan(value: unknown): Plan {
  return PlanSchema.parse(value);
}

/** Parse + validate an Objective from untrusted JSON. */
export function parseObjective(value: unknown): Objective {
  return ObjectiveSchema.parse(value);
}
