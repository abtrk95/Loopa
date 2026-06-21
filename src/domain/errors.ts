/**
 * Explicit, typed error hierarchy. No part of the core swallows exceptions or
 * throws bare strings; failures carry enough structure for the orchestrator to
 * decide between retry, block, and fail.
 */

export type ErrorCategory =
  | 'config'
  | 'intake'
  | 'plan'
  | 'state'
  | 'git'
  | 'process'
  | 'verify'
  | 'provider'
  | 'review'
  | 'event-store'
  | 'control'
  | 'github'
  | 'internal';

export class AgentLoopError extends Error {
  readonly category: ErrorCategory;
  /** Whether retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    category: ErrorCategory,
    message: string,
    opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.category = category;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export class ConfigError extends AgentLoopError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('config', message, { retryable: false, ...(details ? { details } : {}) });
  }
}

export class IntakeError extends AgentLoopError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('intake', message, { retryable: false, ...(details ? { details } : {}) });
  }
}

export class PlanValidationError extends AgentLoopError {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super('plan', message, { retryable: false, details: { issues } });
    this.issues = issues;
  }
}

export class InvalidStateTransitionError extends AgentLoopError {
  constructor(machine: 'run' | 'slice', from: string, to: string) {
    super('state', `illegal ${machine} transition: ${from} -> ${to}`, {
      retryable: false,
      details: { machine, from, to },
    });
  }
}

export class GitError extends AgentLoopError {
  constructor(message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super('git', message, opts);
  }
}

export class ProcessError extends AgentLoopError {
  constructor(message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super('process', message, opts);
  }
}

export class TimeoutError extends ProcessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { retryable: true, ...(details ? { details } : {}) });
    this.name = 'TimeoutError';
  }
}

export class VerificationError extends AgentLoopError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('verify', message, { retryable: true, ...(details ? { details } : {}) });
  }
}

export class ProviderError extends AgentLoopError {
  constructor(message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super('provider', message, { retryable: true, ...opts });
  }
}

export class ScopeViolationError extends AgentLoopError {
  readonly offendingPaths: readonly string[];
  constructor(message: string, offendingPaths: readonly string[]) {
    super('verify', message, { retryable: true, details: { offendingPaths } });
    this.offendingPaths = offendingPaths;
  }
}

export class EventStoreError extends AgentLoopError {
  constructor(message: string, opts: { details?: Record<string, unknown>; cause?: unknown } = {}) {
    super('event-store', message, { retryable: false, ...opts });
  }
}

export class ControlError extends AgentLoopError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('control', message, { retryable: false, ...(details ? { details } : {}) });
  }
}

/** Narrow unknown caught values to a message string without losing data. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
