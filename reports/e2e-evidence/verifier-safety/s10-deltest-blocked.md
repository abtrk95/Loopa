# Blocked: S-001 — deltest

**Reason:** verification failed after 3 attempt(s): test weakening detected
**Attempts:** 3

## Acceptance criteria
- x

## Details
- fail: test weakening (deleted-test-file): src/math.test.js
- fail: test weakening (removed-assertions): removed 2 assertion(s), added 0

## What to do
Inspect `.agent-loop/artifacts/checks/` for the failing check output, then either
fix the blocker manually and run `agent-loop retry`, or adjust the plan/scope.
