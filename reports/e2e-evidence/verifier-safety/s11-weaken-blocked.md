# Blocked: S-001 — weaken

**Reason:** verification failed after 3 attempt(s): test weakening detected
**Attempts:** 3

## Acceptance criteria
- x

## Details
- fail: test weakening (skip): test.skip('adds', () => { expect(true).toBe(true); });
- fail: test weakening (tautology): test.skip('adds', () => { expect(true).toBe(true); });

## What to do
Inspect `.agent-loop/artifacts/checks/` for the failing check output, then either
fix the blocker manually and run `agent-loop retry`, or adjust the plan/scope.
