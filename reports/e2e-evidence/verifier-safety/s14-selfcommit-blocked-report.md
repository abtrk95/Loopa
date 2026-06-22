# Blocked: S-001 — self

**Reason:** agent created its own commit(s); only working-tree edits are allowed
**Attempts:** 1

## Acceptance criteria
- x

## Details
- HEAD moved dae101bc -> f1c1a199 (self-commit bypasses scoped verification)

## What to do
Inspect `.agent-loop/artifacts/checks/` for the failing check output, then either
fix the blocker manually and run `agent-loop retry`, or adjust the plan/scope.
