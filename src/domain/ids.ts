/**
 * Identifier generation. IDs are opaque strings with a typed prefix so they are
 * self-describing in logs and the event store.
 */
import { randomUUID } from 'node:crypto';

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function newRunId(): string {
  return `run_${short()}`;
}

export function newAttemptId(): string {
  return `att_${short()}`;
}

export function newEventId(): string {
  return `evt_${short()}`;
}

export function newCorrelationId(): string {
  return `cor_${short()}`;
}

export function newPlanId(): string {
  return `plan_${short()}`;
}

/** Format a slice index (0-based) into a canonical slice id (S-001, S-002, …). */
export function sliceId(index: number): string {
  return `S-${String(index + 1).padStart(3, '0')}`;
}
