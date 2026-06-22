# Production-Workflow Readiness — Non-Technical Owner

**Date:** 2026-06-22
**Branch:** `production-workflow-nontechnical-review`
**Built on:** `final-realistic-readiness-validation` @ `6bac6ad`
**Disposable repo (live):** `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042` (PRIVATE, reused, re-archived)

## Honest status: **LIMITED PRODUCTION WITH MANDATORY HUMAN REVIEW**

This work stream did **not** change that classification — it *strengthened the trust
surface for a non-technical owner* without removing any guard. The full
issue → triage → real implementation → verifier → AI review → browser → draft PR →
**plain-English PR review** workflow now runs end-to-end and was proven live. It is
still **not** unqualified PRODUCTION READY for the same carried-in reasons (packaging
`private: true` + no LICENSE; live true-parallel and live fallback/switch-on-retry
remain honestly bounded).

## The production workflow, proven end-to-end (live)

```
GitHub issue #10  (Add ticket search by customer name)
  → triage            (dry-run → apply; classified ready after a bug fix)
  → plan              (claude planner; 1 slice)
  → real implementation (claude worker)
  → verifier          (deterministic: scope/secrets/structural/size/weakening/conflict + typecheck/lint/test/build)
  → browser           (real Chrome/CDP screenshot, advisory pass)
  → AI reviewer       (codex; technical findings + plain-English product-owner summary)
  → draft PR #11      (body leads with the human-review section; risk matches the report)
  → PR review report  (NEEDS HUMAN DEV REVIEW / High → .agent-loop/reports/pr-review-11.md)
  → PR comment        (dry-run posts nothing; --apply posts; verified on GitHub)
```

A non-technical owner reading the report can see, in plain English: **what changed,
why, whether checks passed, the risk, whether secrets/forbidden files were touched,
whether the browser check passed, what to test by hand, whether it's safe to review,
and whether to merge / not merge / ask a developer.** Nothing merged, deployed, or
closed.

## What makes it trustworthy (and where it stops)

| Guarantee | How it holds |
| --- | --- |
| Deterministic verifier is the authority | Verdict ladder puts it first; an approving AI reviewer can never upgrade a verifier fail (hermetic + live). |
| No overclaim | A PR with no local run record reads `pr-metadata-only` → **never** SAFE TO REVIEW (live neg-control). |
| Secrets/forbidden blocked | Verifier blocks at commit time; the report shows ❌ and **BLOCKED** (hermetic). |
| Redaction | The whole report is run through the session redactor before write/post (over-redacts rather than under-redacts). |
| No auto-merge/deploy/close | No such verb exists in any github module (asserted by tests); all 7 live issues stayed OPEN. |
| Human decides | Every surface says so; the tool only advises. |

## Final gate (post-changes)

| Command | Result |
| --- | --- |
| `npm ci` | clean |
| `npm run check` (typecheck+lint+test) | **261 passed, 5 skipped** (was 228; +33 new) |
| `npm run build` | clean |
| `node dist/bin/agent-loop.js demo` | COMPLETED 3/3 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm pack --dry-run` | 430.2 kB, 313 files |

## Adversarial audit (and the bugs it caught + fixed)

A 4-lens adversarial workflow (under-blocking / overclaim / secret-leak / consistency)
read the source, tried to break the safety claims, and each candidate finding was
**independently verified** before being accepted. It confirmed a cluster of real
overclaim/consistency holes — all now fixed and covered by regression tests:

| Finding (confirmed) | Fix |
| --- | --- |
| **Disabled safety scan shown as PASS** — `detectSecrets:false` (or `detectTestWeakening:false`) emits no event; the report's "missing event in a COMPLETED run = passed" assumption rendered ✅ for a scan that never ran. | Tri-state guards: missing evidence → **⚠️ NOT CHECKED**, never PASS; blocks SAFE TO REVIEW. |
| **Skipped `allowedCommands` checks shown as PASS** — verifier records them `ok:true` with a "skipped …" summary. | Thread the summary into `CHECK_FINISHED`; skipped checks render as not-run + a concern; blocks SAFE TO REVIEW. |
| **PR body more optimistic than the report** — the body lacked AI-reviewer/browser evidence (only risk was threaded earlier). | PR body now built from the **full event log** → identical verdict to the report. |
| **PR head ≠ local branch** only warned. | Branch mismatch now downgrades the verdict (evidence may describe a different change). |
| **UI changed, browser never ran** | → NEEDS HUMAN DEV REVIEW (a visual change that was never verified). |

Dismissed (correctly not real): zero-slice "completed" run already → DO NOT MERGE
(`totalSlices > 0` guard); last-wins per check id is **by design** (the report shows the
final committed state a merge decision needs). The audit spent ~1.3M tokens across 18
agents; every confirmed finding is now a passing test.

## Carried-in PARTIALs (unchanged; not correctness/safety defects)

1. GitHub Projects v2 / Kanban sync — `gh` token lacks `project` scope; degrades gracefully.
2. Live true-parallel (npm) — worktree `node_modules` constraint; mechanics hermetic-proven.
3. Live fallback / switch-on-retry — configured, not triggered; hermetic-proven.
4. `tui.compactWidth` not wired.
5. Packaging: `private: true`, **no LICENSE** — the standing disqualifier for "full production-ready".

## New honest limitation (this work stream)

- **Over-redaction in the report:** the redactor masked a substring of the repo name in
  the PR URL inside the report. Safe direction (never under-redacts), but it can mangle the
  clickable PR link in the local report. The PR number is shown and the live PR is intact.

## Can the user start on a real project?

**Yes — under mandatory per-PR human review**, on a repo they control, with concurrency 1
and draft-PR-only. The PR review report makes that review fast and trustworthy for a
non-technical owner. It is **not** a license to skip human merge, and it is **not**
auto-anything.
