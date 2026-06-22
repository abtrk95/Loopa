# Final Realistic Readiness — Summary

**Date:** 2026-06-22
**Branch:** `final-realistic-readiness-validation`
**Baseline commit:** `39ec20f` (from `live-github-full-e2e-and-interview-recommendations`)
**Disposable project:** `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042` (PRIVATE)
**Providers used live:** Claude Code 2.1.172 (`claude-sonnet-4-6`), Codex CLI 0.141.0; `gh` 2.93.0.

## Honest status: **LIMITED PRODUCTION WITH MANDATORY HUMAN REVIEW** (stronger than the prior report, but not unqualified production-ready)

A real GitHub project was built feature-by-feature through the full loop with real providers, every safety guarantee held, two real product/doc bugs were found and fixed, and the function-coverage matrix is green for all correctness/safety functionality. It is **not** unqualified PRODUCTION READY because the package is `private: true` with **no LICENSE**, and two capabilities remain honestly bounded (live true-parallel, live fallback/switch-on-retry).

## What was proven live (this validation, fresh repo)
| Capability | Result |
| --- | --- |
| GitHub issue → triage → plan → real-provider exec → verifier → scoped commit → **draft PR** | **PASS** (Issue 1, Claude → PR #7) |
| UI issue with real **browser verification** (CDP/Chrome) | **PASS** — screenshot + console capture; **blocks when broken** (Issue 2 attempts A/B) and **passes when clean** → PR #8 |
| **Multi-model distinct routing** in one run | **PASS** — S-001 `claude`, S-002 `codex` (round-robin), distinct reviewer `codex` → PR #9 |
| Triage classification + gated clarification comments | **PASS** (after fixing a misclassification bug) |
| Interview recommendations + orchestration questions | **PASS** — all 7 fields per question; full orchestration matrix |
| Verifier safety (scope/secret/.git/test-weakening/forbidden/binary/conflict) | **PASS** (controlled fixtures; binary-detection regression test added) |
| Watcher attach/detach/reconnect + status/inspect/logs/diff + pause/resume/stop/retry | **PASS** (live observation + hermetic control semantics) |
| No auto-merge / auto-deploy / auto-close | **PASS** — 6 issues OPEN, only open drafts, no merge/deploy verb exists |
| Independent re-verification of committed code | **PASS** — re-ran checks on each PR branch; all green |

## Honestly bounded (PARTIAL — not correctness/safety risks)
1. **GitHub Projects v2 / Kanban sync** — not exercisable: `gh` token lacks `project` scope + no board. Degrades gracefully; hermetic-proven.
2. **Live true-parallel execution (npm projects)** — git worktrees lack git-ignored `node_modules`, so `concurrency>1` npm checks can't run there. Distinct routing proven at concurrency 1; concurrency mechanics hermetic-proven.
3. **Live fallback / switch-on-retry** — configured but not triggered (both providers succeeded). Hermetic-proven.
4. **`tui.compactWidth`** config key not read by the renderer (doc corrected; `--compact` works).

## Bugs found & fixed (with regression tests)
1. **Triage misclassification (product correctness).** Vague improvement requests ("Make the dashboard better") were classified `unsupported` instead of `needs-info` (so they got no clarification comment). `ACTIONABLE_RE` in `src/github/triage.ts` lacked improvement verbs. **Fixed** + regression test in `github-triage.test.ts`. Re-verified live: Issue 4 now → `needs-info` + 12 clarification questions.
2. **Binary-file detection had no regression test** (impl existed + wired). **Added** two tests in `scope-render.test.ts`.

## Documentation truth fixes (verified against code, then corrected)
- `event-schema.md`: added `browser` source + `BROWSER_VERIFICATION_*` events; clarified `VERIFICATION_PASSED.files` is a **count**, not a list.
- `verification.md`: added the **merge-conflict** check (step 7) to the pipeline.
- `provider-adapters.md`: fake-provider `attempts` is an **array**, not an object.
- `terminal-dashboard.md`: fold threshold is a fixed **90**; `tui.compactWidth` not yet wired.
- `state-machine.md`: a transition emits **either** a semantic event **or** `RUN_STATE_CHANGED`, not both.
- **No production-readiness overclaim was found** in any doc (17 docs audited; 12 fully accurate).

## Tests added (this session): 3
- triage "vague improvement request → needs-info" regression
- scope binary-detection: flagged when `flagBinary` on, not flagged off

## Final gate (post-changes)
| Command | Result |
| --- | --- |
| `npm ci` | clean |
| `npm run check` (typecheck+lint+test) | **228 passed, 5 skipped** (was 225; +3 new) |
| `npm run build` | clean |
| `node dist/bin/agent-loop.js demo` | COMPLETED 3/3 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm pack --dry-run` | 404.4 kB, 308 files |

## Deliverable artifacts
- 3 human-review-ready **draft PRs** (#7 Claude, #8 browser-verified, #9 multi-model) on the disposable repo.
- 6 triaged issues (1/2/3/6 ready, 4 needs-info, 5 too-risky) — all OPEN.
- Reports: `final-readiness-baseline`, `realistic-project-setup`, `…-interview-evidence`, `…-github-triage`, `…-single-provider-run`, `…-browser-run`, `…-multimodel-validation`, `…-negative-controls`, `…-watcher-control`, `full-function-coverage-matrix`, this summary, + `final-readiness-evidence/` (interview transcripts, browser screenshots/JSON).

## Why not PRODUCTION READY (disqualifiers, per the rubric)
- Package is `private: true` and **unpublished**; **no LICENSE** (license decision incomplete).
- Live true-parallel and live fallback/switch-on-retry are **not** proven live (and are **not** claimed as production-grade — bounded honestly).
These are operational/packaging gaps, **not** correctness or safety defects.

## Recommendation
**Safe to use on a real project under mandatory per-PR human review**, with concurrency 1, draft-PR-only, and the documented minimal autonomy flags. Treat it as a strong release candidate: the deterministic verifier is the completion authority, the agent cannot self-approve, secrets/forbidden paths are blocked, and nothing merges or deploys without a human.
