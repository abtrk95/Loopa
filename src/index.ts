/**
 * Public library surface for programmatic use. The CLI (bin/agent-loop.ts) is the
 * primary entry point; these exports let other tools embed the engine.
 */
export { main, VERSION } from './cli/index.js';

// Orchestration
export { openSession, loadPlan, savePlan, loadRunMeta, type Session } from './orchestrator/session.js';
export { createPlan } from './orchestrator/planning.js';
export { RunEngine, type RunResult } from './orchestrator/run.js';

// Domain
export * from './domain/schemas.js';
export { RUN_STATES, SLICE_STATES, type RunState, type SliceState } from './domain/states.js';
export * as errors from './domain/errors.js';

// Events
export { SqliteEventStore, type EventStore } from './events/store.js';
export { project, progressPercent, type RunSnapshot } from './events/projection.js';
export { EVENT_TYPES, type AgentLoopEvent, type EventType } from './events/types.js';

// Config
export { ConfigSchema, defaultConfig, type Config } from './config/config.js';
export { loadConfig } from './config/load.js';

// Providers
export type { ProviderAdapter, ProviderRequest, ProviderResult } from './providers/types.js';
export { createRegistry, ProviderRegistry } from './providers/registry.js';
export { Router } from './providers/routing.js';

// Verification / intake / planning
export { verify, type VerificationResult, type Verdict } from './verify/verifier.js';
export { normalizeInput, type RawInput } from './intake/normalize.js';
export { buildPlan } from './planner/plan.js';
export { validatePlan, assertValidPlan } from './planner/validate.js';

// Watch
export { runWatch } from './watch/dashboard.js';
export { renderDashboard, type WatchModel } from './watch/render.js';
