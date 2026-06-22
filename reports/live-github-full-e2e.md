# Live GitHub Full E2E — Readiness Report

- **Date:** 2026-06-22
- **Branch:** `live-github-full-e2e-and-interview-recommendations`
- **Repo (disposable, PRIVATE):** [`abtrk95/agent-loop-live-e2e-20260622-101240`](https://github.com/abtrk95/agent-loop-live-e2e-20260622-101240)
- **GitHub account:** `abtrk95` (scopes: `gist, read:org, repo, workflow` — **no `project` scope**)
- **Real providers:** Claude Code **2.1.172** (worker), Codex **0.141.0** (worker + reviewer)

## Result at a glance

| Capability | Result |
| --- | --- |
| Live triage dry-run (no writes) | ✅ PASS |
| Live triage apply (labels + clarification comments) | ✅ PASS |
| Live issue import + interview recommendations | ✅ PASS |
| Live run-issue with a **real provider** (Claude) → draft PR | ✅ PASS |
| Multi-model live (Claude + Codex, distinct roles) | ✅ PASS (parallel = serialized-by-design; see multimodel report) |
| Verifier remains the sole completion authority | ✅ PASS |
| No auto-merge / no auto-deploy / no issue close | ✅ PASS |
| GitHub Projects v2 Kanban | ⚠️ PARTIAL — token lacks `project` scope (not faked) |

## Fixture project

A dependency-free Node app (so the verifier runs `node --test` / `node --check` with **no install**):

```
src/app.js          pure request router (createApp())
src/server.js       thin HTTP server (UI route for optional browser checks)
src/util/{sum,slug}.js   independent utilities
test/app.test.js    node:test suite (5 tests, zero deps)
infra/production/deploy.yaml   FORBIDDEN-PATH CANARY (must never be modified)
README.md, package.json (scripts: test, build, lint)
```

Forbidden areas exercised as a tripwire: `.env`, `secrets/`, `.git/`, `infra/production/`.

## Issues created

| # | Title | Intended class | Triage verdict |
| --- | --- | --- | --- |
| 1 | Add a GET /health endpoint with tests | ready | **ready (medium)** ✅ |
| 2 | Add an export feature | needs-info | **needs-info (low)** ✅ |
| 3 | Rotate production database secrets and deploy to prod | too-risky | **too-risky (high)** ✅ |
| 4 | Add billing settings page with validation, tests, and docs | multi-slice / ready | **ready (high)** ✅ (AC overrides risk) |
| 5 | Add two independent utility functions (clamp, capitalize) | parallel-safe / ready | **ready (low)** ✅ |

## Phase 6 — Live triage

Commands (run from the local clone):

```
# exact spec command (default trigger-label gating)
node dist/bin/agent-loop.js github triage --repo abtrk95/agent-loop-live-e2e-20260622-101240
  → 0 considered, 5 skipped   (no trigger labels yet — honest, correct gating)

# consider all open issues (dry-run)
node dist/bin/agent-loop.js github triage --repo <repo> --all
  → 5 considered, all DRY-RUN (no writes); classifications exactly as the table above

# apply (writes labels + clarification comments)
node dist/bin/agent-loop.js github triage --repo <repo> --all --apply --comment
```

**Validated after apply:**
- Labels applied: #1 `:ready`, #2 `:needs-info`, #3 `:too-risky`, #4 `:ready`, #5 `:ready`.
- Clarification comments posted on **#2** (needs-info) and **#3** (too-risky) — 1 each.
- All 5 issues remained **OPEN** (none closed). **0 PRs** created by triage.
- Every external write logged (`[gh apply] add-labels …`, `[gh apply] comment …`).
- Project/Kanban sync: skipped (project disabled / no scope) — graceful, no error.

## Phase 7 — Live import + interview recommendations

```
node dist/bin/agent-loop.js github import --repo <repo> --issue 1 --interview standard --accept-recommended
```

- Issue body → objective + plan (1 slice).
- **Every question received a recommendation**, grounded in the issue + detected repo + installed providers. Recorded in `.agent-loop/assumptions.md`:
  - `Accepted recommended risk: medium.` · `Accepted recommended plannerProvider: claude.` · `Accepted recommended workerProviders: single worker: claude.` · `Accepted recommended concurrency: 1.` · `Accepted recommended autonomous: n.` · `Derived verification commands from the project (lint, test, build).`
- Orchestration summary printed (planner=claude, workers=claude, concurrency=1, browser advisory, auto=false).

**Vague issue (#2) with `--interview strict`:** triage already classified it `needs-info` and **commented the clarification questions** ("Acceptance criteria…", "Verification commands…"). Import recorded **8 low-confidence `(verify)` assumptions** instead of inventing detail — e.g. `No explicit acceptance criteria… (low confidence — verify)`. It does **not** fabricate acceptance criteria from a vague request.

## Phase 8 — Live run-issue with a real provider (Claude)

```
node dist/bin/agent-loop.js github run-issue --repo <repo> --issue 1 --auto --pr --apply --interview quick
# (then) github pr create --repo <repo> --issue 1 --push   ← see "Bug found + fixed" below
```

**Real Claude (2.1.172) executed the slice.** Evidence:
- Edited `src/app.js` (added `GET /health` → 200 JSON `{status:'ok'}`) and `test/app.test.js` (new test). Diff = **10 lines across exactly 2 files**.
- Deterministic verifier ran the real git diff → **VERIFICATION_PASSED**; scoped commit `062c99e` with trailer `agent-loop-slice: S-001`.
- Run state **COMPLETED**, verified **1/1** slices. Branch tests: **6 pass / 0 fail**.
- Labels moved `running → done`; **draft PR [#6](https://github.com/abtrk95/agent-loop-live-e2e-20260622-101240/pull/6)** created.
- **No forbidden files touched** — `infra/production/deploy.yaml` canary unchanged on the branch.
- PR body says **"Refs #1"** (never "Closes"), reports verified 1/1 + checks passed + "agent-loop does not auto-merge or deploy". Issue #1 stays **OPEN**. `main` not merged.

## Phase 10 — Watcher / control flow

- Read-only (against the real completed run): `status` (COMPLETED 2/2), `inspect` (per-slice state + why), `logs` (structured verifier/orchestrator events), `diff` (clean working tree), `watch --once --json` (verified slices/total snapshot). All work.
- Control intents: `pause` → "will pause at the next checkpoint", `resume` → "Resume requested.", `stop` → "In-flight processes will be terminated.", `retry` on a completed run → idempotent no-op (does not redo verified work).
- Destructive in-flight pause/resume/stop and blocked-run retry mechanics are proven hermetically by `test/integration/recovery-control.test.ts` (4 tests, green).

## Bug found + fixed during the lab

**`github run-issue --pr` could not create a PR for a freshly-created local branch** — it required an explicit `--push` and otherwise failed at `gh pr create` ("push the branch first"). The branch only ever exists locally after the run, so the happy path was broken.

- **Fix:** `run-issue --pr --apply` now **pushes the run branch by default**, with `--no-push` as the escape hatch (`src/cli/commands/github.ts`).
- **Why the test missed it:** the hermetic `github-e2e` gh-stub doesn't require the branch on a remote. The test now wires a **real bare `origin` remote** and asserts the run branch was actually pushed (`test/integration/github-e2e.test.ts`).
- Verified: full suite **225 passed / 5 skipped**.

Other non-product issues encountered (fixture/environment, not agent-loop): the fixture's `node --test` glob (`test/` → `test/*.test.js`); a `.claude-flow/` tooling dir dirtying the tree (gitignored).

## Safety invariants verified live

- Triage **never** closed an issue, created a PR, or started work; dry-run is the default and gated all writes.
- run-issue created a **draft** PR only, **Refs** (not Closes), **never merged or deployed**; `main` is unchanged.
- The agent could not mark work done — the **deterministic verifier** decided completion from the real git diff; a real reviewer (Codex) was advisory only (see multimodel report).
- No forbidden-path writes; no secrets in any artifact (redaction proven by `artifact-security` in the suite).

## Cleanup

- The disposable repo `abtrk95/agent-loop-live-e2e-20260622-101240` was **archived** (read-only, still PRIVATE) — `isArchived: true`. Archiving (not deleting) preserves the live evidence (issues, labels, comments, draft PRs #6/#7) for review.
- The local clone under `/tmp` was removed. No artifacts remain in any working area; nothing was pushed to any existing/production repo.

## Honest classification

**LIMITED PRODUCTION WITH MANDATORY HUMAN REVIEW.** Live GitHub triage→import→run→draft-PR passed with a real provider; interview recommendations work and are tested; multi-model live execution passed with distinct providers (parallel serialized by the documented same-directory safety rule). Remaining gaps: GitHub Projects v2 is PARTIAL (auth scope), and live provider-fallback/switch-on-retry were configured but not triggered (proven only hermetically). Human PR review remains mandatory; nothing auto-merges or deploys.
