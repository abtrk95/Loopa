# Blocked: S-001 — conflict

**Reason:** verification failed after 3 attempt(s): unresolved merge conflict markers
**Attempts:** 3

## Acceptance criteria
- x

## Details
- fail: merge conflict marker: <<<<<<< HEAD
- fail: merge conflict marker: =======
- fail: merge conflict marker: >>>>>>> other

## What to do
Inspect `.agent-loop/artifacts/checks/` for the failing check output, then either
fix the blocker manually and run `agent-loop retry`, or adjust the plan/scope.
