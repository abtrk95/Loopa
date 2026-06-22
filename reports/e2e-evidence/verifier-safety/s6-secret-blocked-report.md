# Blocked: S-001 — secret

**Reason:** potential secret in diff
**Attempts:** 1

## Acceptance criteria
- secret file

## Details
- block: secret: const k="***REDACTED***";
- block: secret: const t="***REDACTED***";

## What to do
Inspect `.agent-loop/artifacts/checks/` for the failing check output, then either
fix the blocker manually and run `agent-loop retry`, or adjust the plan/scope.
