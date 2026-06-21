/**
 * Run and slice state machines.
 *
 * Transitions are explicit and validated. The orchestrator is the ONLY component
 * that mutates state, and it must route every change through `assertRunTransition`
 * / `assertSliceTransition`, which throw on an illegal edge. State is also derived
 * from the event log (see events/projection.ts); these tables keep the projection
 * and the live engine in agreement.
 */
import { InvalidStateTransitionError } from './errors.js';

export const RUN_STATES = [
  'CREATED',
  'INTAKE',
  'PLANNING',
  'PLAN_READY',
  'RUNNING',
  'PAUSED',
  'BLOCKED',
  'FINAL_VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const SLICE_STATES = [
  'PENDING',
  'READY',
  'PREPARING',
  'EXECUTING',
  'VERIFYING',
  'REVIEWING',
  'FIXING',
  'COMMITTING',
  'COMPLETED',
  'RETRY_PENDING',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;
export type SliceState = (typeof SLICE_STATES)[number];

/** Run states from which no further transition is allowed. */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

/** Slice states from which no further transition is allowed. */
export const TERMINAL_SLICE_STATES: ReadonlySet<SliceState> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  CREATED: ['INTAKE', 'CANCELLED', 'FAILED'],
  INTAKE: ['PLANNING', 'BLOCKED', 'CANCELLED', 'FAILED'],
  PLANNING: ['PLAN_READY', 'BLOCKED', 'CANCELLED', 'FAILED'],
  PLAN_READY: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['PAUSED', 'BLOCKED', 'FINAL_VERIFYING', 'CANCELLED', 'FAILED'],
  PAUSED: ['RUNNING', 'CANCELLED', 'FAILED'],
  BLOCKED: ['RUNNING', 'PAUSED', 'CANCELLED', 'FAILED'],
  FINAL_VERIFYING: ['COMPLETED', 'RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

const SLICE_TRANSITIONS: Readonly<Record<SliceState, readonly SliceState[]>> = {
  PENDING: ['READY', 'CANCELLED', 'BLOCKED'],
  READY: ['PREPARING', 'CANCELLED', 'BLOCKED'],
  PREPARING: ['EXECUTING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  EXECUTING: ['VERIFYING', 'RETRY_PENDING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['REVIEWING', 'COMMITTING', 'RETRY_PENDING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  REVIEWING: ['COMMITTING', 'FIXING', 'RETRY_PENDING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  FIXING: ['VERIFYING', 'RETRY_PENDING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  COMMITTING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  RETRY_PENDING: ['READY', 'PREPARING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  BLOCKED: ['READY', 'CANCELLED', 'FAILED'],
  FAILED: [],
  CANCELLED: [],
};

export function canRunTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canSliceTransition(from: SliceState, to: SliceState): boolean {
  return SLICE_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canRunTransition(from, to)) {
    throw new InvalidStateTransitionError('run', from, to);
  }
}

export function assertSliceTransition(from: SliceState, to: SliceState): void {
  if (!canSliceTransition(from, to)) {
    throw new InvalidStateTransitionError('slice', from, to);
  }
}

export function isTerminalRunState(s: RunState): boolean {
  return TERMINAL_RUN_STATES.has(s);
}

export function isTerminalSliceState(s: SliceState): boolean {
  return TERMINAL_SLICE_STATES.has(s);
}
