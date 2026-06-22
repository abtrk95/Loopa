# Phase 9 — Real Multi-Model Validation

**Date:** 2026-06-22 · Repo: `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042`
**Providers:** workers `[claude:claude-sonnet-4-6, codex]` (round-robin), reviewer `codex`, fallback `[codex]`, `switchProviderOnRetry: true`, concurrency `1`.

## Why a 2-story plan (not `run-issue --issue 6` directly)
The deterministic planner emits **one** slice per issue/idea (documented: "one story → one slice; an idea → a single conservative slice"). Distinct-worker routing needs ≥2 slices, so Issue 6's two independent utilities were expressed as a 2-story JSON PRD (`/tmp/supportdesk-utils-prd.json`) with **disjoint `allowedPaths`** and `parallelSafe: true`. The resulting draft PR (**#9**) references issue #6. This is exactly the structured-input path the planner supports.

## Result: PASS for the core multi-model claims; PARTIAL (hermetic) for live-parallel + live-fallback

### Distinct-provider worker routing — PROVEN LIVE ✓
From the event log (`PROVIDER_SELECTED` payloads):
| Slice | Worker | Model | Commit |
| --- | --- | --- | --- |
| S-001 Format ticket ID | **claude** | claude-sonnet-4-6 | `f204f17` (trailer `agent-loop-slice: S-001`) |
| S-002 Format customer initials | **codex** | (account default) | `37da06a` (trailer `agent-loop-slice: S-002`) |

Round-robin assigned a **genuinely different provider per slice**, live. Disjoint scopes honored: S-001 touched only `src/utils/ticketId.ts` + `tests/ticketId.test.ts`; S-002 only `src/utils/initials.ts` + `tests/initials.test.ts`. Run COMPLETED 2/2 + FINAL_VERIFICATION. Independent re-verify: **test 11 passed**.

### Reviewer recorded + cannot override the verifier ✓
`REVIEW_STARTED`/`REVIEW_FINISHED` events show reviewer **codex** ran on **both** slices (`verdict: pass`, `findings: 0`, `index 0 of 1`). On S-001 the reviewer (codex) was **distinct** from the worker (claude) — cross-model review, live.
- The reviewer is **advisory and runs only after a verifier pass**; it can never turn a verifier fail into a pass. Proven hermetically (baseline-passing): `verifier-engine.test.ts` → *"reviewer integration (advisory, never overrides verifier) > blocks when the reviewer returns blocked"* and *"passes when the reviewer returns pass"*, plus `reviewer-consensus.test.ts`.

### Concurrency / serialization — serialized here; live-parallel PARTIAL (honest) ⚠
- This run used **concurrency 1**, so the two slices **serialized** (S-001 then S-002) — yet round-robin still routed distinct workers. This was a deliberate choice:
- **True live parallel execution is constrained in this repo:** parallel slices run in isolated **git worktrees**, and the executor runs the project checks with `cwd = worktree` (`executor.ts:421`). `node_modules` is git-ignored, so it does **not** exist in a fresh worktree → `npm run typecheck/lint/test/build` would fail there. Running concurrency > 1 against an npm project without provisioning `node_modules` per worktree would block on environment, not logic. I did **not** spend a paid run on a setup guaranteed to fail for an environmental reason.
- **Concurrency mechanics are proven hermetically** (baseline-passing `parallel.test.ts`, fake provider + node-free checks): *"runs two independent slices concurrently and integrates both commits"* and *"serializes slices with overlapping scope (no corruption)"*. So: independent scopes parallelize, overlapping scopes serialize — proven, just not against live npm checks.
- **Status: live distinct-routing PASS; live true-parallel PARTIAL (hermetic-proven; environment-limited for npm projects).**

### Fallback / switch-on-retry — configured; live PARTIAL (hermetic-proven) ⚠
- Config had `fallbackOrder: [codex]` and `switchProviderOnRetry: true`. Both workers **succeeded on attempt 1** (`fallback:false` in every `PROVIDER_SELECTED`), so neither fallback nor switch-on-retry **triggered** — forcing a real provider failure safely was not attempted (would require sabotaging a real CLI).
- **Proven hermetically** (baseline-passing): `C7: provider fallback > fails over to the next provider when the primary cannot produce a result`; switch-on-retry routing in `orchestration-fixes.test.ts`.
- **Status: live PARTIAL (not triggered); hermetic PASS.**

### Draft-PR-only / safety ✓
PR **#9** `isDraft=true`, base `master`, Refs #6; issue #6 remains OPEN; no merge/deploy. All three E2E PRs (#7, #8, #9) are open drafts on `master`.

## Verdict
**Multi-model = PASS** for live distinct-provider worker routing, distinct cross-model reviewer, reviewer-can't-override-verifier, and draft-PR-only. **PARTIAL (hermetic-proven, honestly bounded)** for live true-parallel execution (environment-limited by worktree `node_modules` for npm projects) and live fallback/switch-on-retry (configured, not triggered). This matches — and re-confirms on a fresh repo — the prior multimodel finding.
