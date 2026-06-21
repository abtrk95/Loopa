/**
 * Clock abstraction. Wall-clock access goes through a Clock so tests can inject a
 * deterministic time source. Pure functions in the core never call Date.now()
 * directly; they take a Clock or an explicit timestamp.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** ISO-8601 timestamp for the current instant. */
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** A controllable clock for deterministic tests. */
export class FixedClock implements Clock {
  private current: number;
  constructor(startMs = 0) {
    this.current = startMs;
  }
  now(): number {
    return this.current;
  }
  iso(): string {
    return new Date(this.current).toISOString();
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
