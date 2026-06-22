# Non-Technical PR Review — Validation Report

**Date:** 2026-06-22
**Branch:** `production-workflow-nontechnical-review` (off `final-realistic-readiness-validation` @ `6bac6ad`)
**Disposable project:** `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042` (PRIVATE — REUSED, temporarily unarchived for validation, re-archived after)
**Providers used live:** Claude Code 2.1.172 (`claude-sonnet-4-6`) as planner+worker, Codex CLI 0.141.0 as reviewer; `gh` 2.93.0; real headless Chrome (CDP) for browser evidence.

## Goal

Prove the full production-use workflow ends in a review package a **non-technical
product owner** can trust — without any auto-merge, auto-deploy, or auto-close, and
with the deterministic verifier remaining the sole completion authority.

## What was proven LIVE (fresh run this session)

| Step | Command | Result |
| --- | --- | --- |
| Triage (dry-run) | `github triage --repo … --issue 10` | classified (revealed a bug — see below) |
| Triage (apply) | `… --issue 10 --apply` | label applied; after fix → **ready** (5 acceptance criteria found) |
| Real implementation | `github run-issue --repo … --issue 10 --auto --pr --apply` | **COMPLETED 1/1** — claude worker → codex reviewer → browser verification → scoped commit → draft **PR #11** |
| Browser verification | (wired in run) | **real CDP/Chrome PNG** `S-001__root.png` (36 KB) + advisory pass |
| Live evidence | `status` / `logs` | RUNNING→COMPLETED; REVIEW_FINISHED, BROWSER_VERIFICATION_FINISHED, COMMIT_CREATED, FINAL_VERIFICATION observed live |
| **PR review report** | `github pr review --repo … --pr 11` | **NEEDS HUMAN DEV REVIEW (risk: High)** → `.agent-loop/reports/pr-review-11.md` |
| PR body | `gh pr view 11` | leads with the plain-English human-review section; **risk matches the report** after fix |
| Comment (dry-run) | `pr review --pr 11 --comment` | `[gh DRY-RUN] pr-comment` — **nothing posted** |
| Comment (apply) | `pr review --pr 11 --comment --apply` | **posted** — verified 1 comment containing “Plain-English review” on PR #11 |

### The generated report (PR #11) — verbatim highlights

- **Verdict:** 🟡 NEEDS HUMAN DEV REVIEW · **Risk:** High · **Recommendation:** Ask a developer to review before merging.
- **Plain-English summary:** “agent-loop worked on ‘Add ticket search by customer name’ … The automatic checks passed, **but there are a few things a developer should confirm** … A second AI reviewer looked at the code and did not object. The app was opened in a browser and the screen was captured successfully. Nothing was merged or deployed.”
- **What changed** (from the codex reviewer’s product-owner layer): “A Search field was added above the ticket list so agents can type a customer name and narrow the visible tickets.”
- **Checks:** Tests ✅ · Build ✅ · Typecheck ✅ · Lint ✅ · Browser/UI ✅
- **Security & safety:** Secrets ✅ · Forbidden/out-of-scope ✅ · Protected locations ✅ · Tests not weakened ✅ · No conflict markers ✅
- **Main risks:** “touches areas marked HIGH risk”; “3 assumptions recorded”; plus the reviewer’s plain note: “Low risk. The change only affects what tickets are shown…”.
- **Manual checks (9):** acceptance criteria + the reviewer’s own steps (“Type part of a customer name, such as acme, and confirm only matching tickets remain”) + “Open the saved screenshot … `S-001__root.png`”.
- **Files changed:** User interface → `src/App.tsx`; Tests → `tests/app.test.tsx`.
- **Footer:** “agent-loop never merges, deploys, or closes issues automatically … The deterministic checks are the authority; the AI reviewer can flag problems but can never approve over a failed check.”

## Negative controls (Phase 9)

| Control | Result |
| --- | --- |
| Unsafe request (“Add production secrets and deploy automatically”, #5) | **too-risky** at triage — **no run, no PR, no secret** |
| `pr review` with NO local run evidence | **DO NOT MERGE** (`generatedFrom: pr-metadata-only`) — refuses to claim safety it can’t verify |
| Nothing auto-closed | all 7 issues (1–6, 10) remain **OPEN** |
| No PR for the unsafe issue | only the 4 legitimate feature branches exist on the repo |
| Verifier fail → report (hermetic) | **DO NOT MERGE**; secret/forbidden → **BLOCKED** |
| Reviewer “pass” + verifier fail (hermetic) | **DO NOT MERGE** — AI cannot override the verifier |
| Secret in a reviewer finding (hermetic) | masked by the redactor in the rendered report |

## Bugs found & fixed (with regression tests)

1. **Triage missed bullet-list acceptance criteria.** Only `- [ ]` checkboxes counted; a `## Acceptance criteria` bullet list did not. Combined with the conservative high-risk heuristic (the issue named `.env`/`secrets`/`production` as *do-not-touch* notes), a well-specified issue (#10) was mislabeled **too-risky**. Fixed with `issueAcceptanceCriteria()` (recognizes bullets under an AC-style heading). Live re-verify: #10 **too-risky → ready**. Regression test added.
2. **PR-body risk could be more optimistic than the report.** The draft-PR body’s human-review section was built from the snapshot alone (no slice risk), so it read **SAFE TO REVIEW** while the full `pr review` report (which loads the plan) read **NEEDS HUMAN DEV REVIEW**. Fixed by threading the plan into the PR body so both surfaces report the **same** risk/verdict. Live re-verify: PR #11 body now **NEEDS HUMAN DEV REVIEW / High**.

## Tests added: 27

- `test/integration/pr-review.test.ts` — **26 tests**: verdict precedence (verifier authority; reviewer cannot override; secret/forbidden → BLOCKED; required-browser → BLOCKED; advisory-browser/high-risk → NEEDS HUMAN DEV REVIEW; no-local-run never SAFE), report-field generation, manual-checklist, risk classification, file grouping, secret redaction, screenshot references, product-owner schema, and `GhClient.viewPr`/`commentPr` dry-run-vs-apply via a `gh` stub.
- `test/integration/github-triage.test.ts` — **+1**: bullet-list acceptance-criteria regression.

## Honest limitations of the report

- **Over-redaction:** the redactor masked a substring of the repo name in the PR URL inside the report (`…supportde***REDACTED***/pull/11`). This is the *safe* failure direction (it never under-redacts), but it can mangle the clickable PR link in the local report. Cosmetic; the PR number is shown and the live PR is intact.
- **A clean COMPLETED run is treated as having passed every safety scan** (true by construction — the verifier only commits code that cleared every scan). For a PR with **no** local run record the report degrades to `pr-metadata-only` and never says SAFE TO REVIEW.
- The report is **advice**, not a gate. It deliberately cannot merge, deploy, approve, or close.

## Verdict

The non-technical PR review report **works end-to-end against a real PR**, is
understandable without reading code, includes tests/checks/browser/security status,
gives a clear recommendation, never hides risk, and **never says “safe to merge.”**
The deterministic verifier remains the final authority and the AI reviewer cannot
override it.
