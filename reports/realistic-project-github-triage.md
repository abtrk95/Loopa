# Phase 6 — GitHub Triage Live Validation

**Date:** 2026-06-22 · Repo: `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042`

## Result: PASS (with one product bug found + fixed)

## Dry-run (default) — NO writes
```
agent-loop github triage --repo <r> --all
```
- Classifications previewed; every external action logged as `[gh DRY-RUN]`.
- **Verified: issue labels still `[]` on all 6 issues after the dry-run** (zero writes).

## Bug found & fixed: vague improvement request misclassified
On the first dry-run, **Issue #4 "Make the dashboard better"** classified as **`unsupported`** instead of the expected **`needs-info`**. Root cause: `ACTIONABLE_RE` in `src/github/triage.ts` omitted improvement verbs (`improve`, `enhance`, …), so a vague-but-actionable improvement request fell into the "reads as a question/discussion" (`unsupported`) branch and therefore got **no clarification comment**.

**Fix:** extended `ACTIONABLE_RE` to recognize improvement intents (`improve|enhance|optimi[sz]e|polish|redesign|revamp|streamline|modernize|simplify|rework|clean up|speed up` and `make … better/faster/easier/more`). Now a vague improvement request is `needs-info` (actionable but thin → needs clarification), consistent with the existing test philosophy. Pure questions (`How do I run this?`) still classify `unsupported`.
- **Regression test added:** `test/integration/github-triage.test.ts` → *"classifies a vague improvement request as needs-info (actionable but thin), not unsupported"*.
- `npx vitest run test/integration/github-triage.test.ts` → **18 passed** (incl. new test). Rebuilt `dist`.

## Final classifications (match the spec)
| Issue | Title | Classification | Expected | ✓ |
| --- | --- | --- | --- | --- |
| #1 | Add ticket creation form with validation | `ready` (low) | ready | ✓ |
| #2 | Add ticket filters and SLA badges | `ready` (low) | ready | ✓ |
| #3 | Add customer sidebar and settings page | `ready` (low) | ready / high-risk ready | ✓ |
| #4 | Make the dashboard better | `needs-info` (low) | needs-info | ✓ (after fix) |
| #5 | Add production secrets and deploy automatically | `too-risky` (high) | too-risky/unsupported | ✓ |
| #6 | Add independent formatting utilities | `ready` (low) | ready | ✓ |

## Apply mode
```
agent-loop github triage --repo <r> --all --apply --comment
```
Verified against the live repo afterwards:
- **Labels applied correctly** — each issue carries exactly its classification label (`agent-loop:ready` / `:needs-info` / `:too-risky`).
- **Clarification comments posted only on #4 (needs-info) and #5 (too-risky)** — 1 comment each; **0 comments** on the ready issues (#1/#2/#3/#6). Comment body = "agent-loop triage: needs-info … Could you clarify: …" with 12 interview questions + "_agent-loop will not start work until then, and never auto-merges or deploys._"
- **Issue #5 (too-risky) was not executed** — triage prints *"Labels/comments applied. No work was started."*
- **No PR created by triage** — `gh pr list --state all` = **0**.
- **No issue closed** — all 6 issues remain **OPEN**.
- **No merge / deploy path** — triage has no such verb (asserted hermetically by `triageRepo > never invokes a merge / deploy / close verb`).

## GitHub Projects v2 / Kanban — PARTIAL (honest)
```
agent-loop github project --repo <r>
→ "No GitHub Project (v2) detected … Board sync will be skipped (labels/PRs still work)."
```
- The active `gh` token scopes are `gist, read:org, repo, workflow` — **no `project` scope**, and no Project board exists on this disposable repo.
- Board sync therefore **cannot be exercised live in this environment**. The code path degrades gracefully (labels/PRs still work; sync is skipped with a clear message). Project-sync write/skip behavior is covered hermetically (`github-triage.test.ts` detects a stubbed project + status options).
- **Status: PARTIAL — not provable live here; not claimed as production-validated.**

**Phase 6 verdict: PASS.** Triage classification (post-fix), dry-run safety, label application, gated clarification comments, and the no-PR/no-close/no-merge guarantees all hold live. Projects v2 remains PARTIAL by environment constraint.
