/**
 * Validated, versioned configuration schema. Zero-config is valid: defaults use
 * the deterministic `fake` provider so `demo` and tests run with no credentials.
 * Real usage overrides roles/providers via the project config file, env, or CLI.
 *
 * Precedence (low → high) is resolved in load.ts:
 *   built-in defaults → user config → project config → env → CLI overrides.
 */
import { z } from 'zod';
import { RiskPolicySchema, CheckSpecSchema, CommandSpecSchema } from '../domain/schemas.js';

export const CONFIG_VERSION = 1 as const;

/** A reference to a provider + model for a given role. */
export const ProviderRefSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().optional(),
    weight: z.number().int().positive().default(1),
    /** Free-form options passed to the adapter (e.g. extra CLI flags). */
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

export const FixerRefSchema = z.union([
  z.object({ strategy: z.literal('same-as-worker') }).strict(),
  ProviderRefSchema,
]);
export type FixerRef = z.infer<typeof FixerRefSchema>;

export const RolesSchema = z
  .object({
    planner: ProviderRefSchema.default({ provider: 'fake' }),
    workers: z.array(ProviderRefSchema).min(1).default([{ provider: 'fake', weight: 1, options: {} }]),
    /** Single reviewer. For multi-reviewer consensus across DISTINCT providers,
     * use `reviewers` (below); `reviewer` remains the fallback/legacy single role. */
    reviewer: ProviderRefSchema.optional(),
    /** A panel of DISTINCT reviewers. When non-empty, consensus runs each of these
     * once (independent provider+model per vote) instead of re-sampling one reviewer.
     * Takes precedence over `reviewer` + `routing.reviewerConsensus`. */
    reviewers: z.array(ProviderRefSchema).default([]),
    fixer: FixerRefSchema.default({ strategy: 'same-as-worker' }),
    /** RESERVED / EXPERIMENTAL: accepted but not yet invoked by the orchestrator. */
    judge: ProviderRefSchema.optional(),
    /** RESERVED: a future provider-driven browser role. The wired UI/browser
     * verification is configured under the top-level `browser` section, not here. */
    browser: ProviderRefSchema.optional(),
  })
  .strict();
export type Roles = z.infer<typeof RolesSchema>;

export const RoutingSchema = z
  .object({
    workerStrategy: z.enum(['static', 'round-robin', 'weighted', 'capability']).default('round-robin'),
    /** Ordered provider names to try when the primary fails. */
    fallbackOrder: z.array(z.string()).default([]),
    /** On retry, switch to the next fallback provider instead of repeating. */
    switchProviderOnRetry: z.boolean().default(false),
    /** Run N independent reviewers and require consensus (1 = single reviewer). */
    reviewerConsensus: z.number().int().positive().default(1),
  })
  .strict();
export type Routing = z.infer<typeof RoutingSchema>;

export const ExecutionSchema = z
  .object({
    /** Max slices executing concurrently (parallel worktrees). */
    concurrency: z.number().int().positive().default(1),
    maxRetriesPerSlice: z.number().int().nonnegative().default(2),
    retryBackoffMs: z.number().int().nonnegative().default(2000),
    retryJitterMs: z.number().int().nonnegative().default(500),
    agentTimeoutMs: z.number().int().positive().default(600_000),
    checkTimeoutMs: z.number().int().positive().default(300_000),
    /** Stop the run if exceeded (0 = unlimited). */
    budgetUsd: z.number().nonnegative().default(0),
    budgetTokens: z.number().int().nonnegative().default(0),
    /** Per-process captured output cap (bytes). */
    maxOutputBytes: z.number().int().positive().default(2_000_000),
  })
  .strict();
export type Execution = z.infer<typeof ExecutionSchema>;

export const GitConfigSchema = z
  .object({
    branchPrefix: z.string().default('agent-loop/'),
    requireCleanTree: z.boolean().default(true),
    /** Explicit, noisy override to run on a dirty tree. */
    allowDirty: z.boolean().default(false),
  })
  .strict();
export type GitConfig = z.infer<typeof GitConfigSchema>;

export const VerificationConfigSchema = z
  .object({
    /** Global checks (run during FINAL_VERIFYING and as slice defaults). */
    commands: z.array(CheckSpecSchema).default([]),
    /** Slices may only run commands whose argv[0] is in this allowlist (empty = allow all configured checks). */
    allowedCommands: z.array(z.string()).default([]),
    deniedCommands: z.array(z.string()).default([]),
    maxDiffLines: z.number().int().positive().default(800),
    detectTestWeakening: z.boolean().default(true),
    detectSecrets: z.boolean().default(true),
    flagBinary: z.boolean().default(true),
  })
  .strict();
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;

export const BrowserConfigSchema = z
  .object({
    /** Master switch. Off by default — zero behaviour change for existing runs. */
    enabled: z.boolean().default(false),
    /** Command that starts the app under test as a long-running server. */
    startCommand: CommandSpecSchema.optional(),
    /** Base URL probed for readiness and used to resolve `routes`. */
    baseUrl: z.string().url().default('http://127.0.0.1:3000'),
    /** Path used for the readiness probe (defaults to the first route / '/'). */
    readyPath: z.string().optional(),
    /** Route paths to navigate, capture, and scan for console errors. */
    routes: z.array(z.string()).default(['/']),
    /** ms to wait for the app to begin serving `baseUrl`. */
    startupTimeoutMs: z.number().int().positive().default(30_000),
    /** ms budget per route navigation. */
    navigationTimeoutMs: z.number().int().positive().default(15_000),
    /** Treat any captured console error / page error as a failure. */
    failOnConsoleError: z.boolean().default(true),
    /** When true a browser failure BLOCKS the slice; otherwise it is advisory
     * (recorded as a flag, never overriding the deterministic verifier). */
    required: z.boolean().default(false),
    /** Engine: 'auto' uses CDP/Chrome when a binary is found, else the HTTP probe. */
    engine: z.enum(['auto', 'cdp', 'http']).default('auto'),
    /** Explicit Chrome/Chromium binary for real (CDP) screenshots + console capture. */
    chromePath: z.string().optional(),
  })
  .strict();
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export const TuiConfigSchema = z
  .object({
    color: z.boolean().default(true),
    refreshMs: z.number().int().positive().default(1000),
    compactWidth: z.number().int().positive().default(90),
  })
  .strict();
export type TuiConfig = z.infer<typeof TuiConfigSchema>;

export const GithubConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    remote: z.string().default('origin'),
    draftPr: z.boolean().default(true),
  })
  .strict();
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

export const LoggingConfigSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    retentionDays: z.number().int().nonnegative().default(30),
  })
  .strict();
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

export const ConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
    /** Run unattended: make conservative assumptions, never prompt. */
    auto: z.boolean().default(false),
    roles: RolesSchema.default({}),
    routing: RoutingSchema.default({}),
    execution: ExecutionSchema.default({}),
    git: GitConfigSchema.default({}),
    verification: VerificationConfigSchema.default({}),
    browser: BrowserConfigSchema.default({}),
    riskPolicy: RiskPolicySchema.default({}),
    tui: TuiConfigSchema.default({}),
    github: GithubConfigSchema.default({}),
    logging: LoggingConfigSchema.default({}),
    /** Per-provider overrides (binary path, default model, extra args). */
    providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;

/** The fully-defaulted configuration. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
