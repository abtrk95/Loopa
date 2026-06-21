/**
 * Event taxonomy and envelope.
 *
 * The event store is the canonical, append-only history of a run. State is
 * DERIVED from events (see projection.ts) — the coding agent never writes
 * authoritative progress events. Two "state-changed" events
 * (RUN_STATE_CHANGED / SLICE_STATE_CHANGED) are the authoritative drivers of the
 * run/slice state machines; the remaining semantic events carry audit detail and
 * data the dashboard renders.
 */
import { z } from 'zod';

export const EVENT_SCHEMA_VERSION = 1 as const;

export const EVENT_TYPES = [
  // run lifecycle
  'RUN_CREATED',
  'INTAKE_STARTED',
  'OBJECTIVE_CREATED',
  'PLAN_CREATED',
  'PLAN_VALIDATED',
  'RUN_STARTED',
  'RUN_PAUSED',
  'RUN_RESUMED',
  'RUN_STOP_REQUESTED',
  'RUN_STATE_CHANGED',
  'ASSUMPTION_RECORDED',
  // slice lifecycle
  'SLICE_READY',
  'SLICE_STARTED',
  'SLICE_STATE_CHANGED',
  'PROVIDER_SELECTED',
  // agent process
  'AGENT_PROCESS_STARTED',
  'AGENT_PROCESS_OUTPUT',
  'AGENT_PROCESS_EXITED',
  // filesystem / git
  'FILE_CHANGED',
  'COMMIT_CREATED',
  'ROLLBACK_STARTED',
  'ROLLBACK_FINISHED',
  // checks / verification
  'CHECK_STARTED',
  'CHECK_OUTPUT',
  'CHECK_FINISHED',
  'VERIFICATION_STARTED',
  'VERIFICATION_PASSED',
  'VERIFICATION_FAILED',
  // review
  'REVIEW_STARTED',
  'REVIEW_FINISHED',
  // browser / UI verification (advisory; never overrides the deterministic verifier)
  'BROWSER_VERIFICATION_STARTED',
  'BROWSER_VERIFICATION_FINISHED',
  // slice terminal
  'SLICE_COMPLETED',
  'SLICE_RETRY_SCHEDULED',
  'SLICE_BLOCKED',
  // final
  'FINAL_VERIFICATION_STARTED',
  'FINAL_VERIFICATION_FINISHED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'RUN_CANCELLED',
  // integrations
  'PR_CREATED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** The component that produced an event. Agents are never a source. */
export const EVENT_SOURCES = [
  'orchestrator',
  'intake',
  'planner',
  'git',
  'process',
  'verifier',
  'reviewer',
  'browser',
  'control',
  'github',
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** Validated event envelope as stored and read back. */
export const AgentLoopEventSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    eventId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    ts: z.string().min(1),
    runId: z.string().min(1),
    sliceId: z.string().nullable().default(null),
    attemptId: z.string().nullable().default(null),
    correlationId: z.string().nullable().default(null),
    source: z.enum(EVENT_SOURCES),
    type: z.enum(EVENT_TYPES),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type AgentLoopEvent = z.infer<typeof AgentLoopEventSchema>;

/** What a caller provides to append(); the store assigns seq/eventId/ts. */
export interface NewEvent {
  runId: string;
  type: EventType;
  source: EventSource;
  sliceId?: string | null;
  attemptId?: string | null;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Optional dedupe key. If set and an event with the same key already exists,
   * append() is a no-op that returns the existing event. Used to make recording
   * of side effects (e.g. a commit) idempotent across crashes/retries.
   */
  idempotencyKey?: string;
}
