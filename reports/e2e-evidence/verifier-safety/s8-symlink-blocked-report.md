# Blocked: S-001 — symlink

**Reason:** symlink-escape detected
**Attempts:** 1

## Acceptance criteria
- x

## Details
- block: symlink-escape: src/escape.lnk

## What to do
Inspect `.agent-loop/artifacts/checks/` for the failing check output, then either
fix the blocker manually and run `agent-loop retry`, or adjust the plan/scope.
