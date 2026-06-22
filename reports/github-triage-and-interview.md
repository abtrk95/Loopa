# GitHub triage + interview — implementation report

**Branch:** `github-triage-and-interview` (cut from `live-real-provider-smoke`)
**Date:** 2026-06-22

This change adds (1) an interactive **interview/intake wizard** and (2) a **GitHub
triage + Kanban** orchestration layer, **without weakening the local deterministic
safety core**. Completion is still `verified-completed / total` slices; the verifier is
untouched; there is no auto-merge/auto-deploy/issue-close path.

## Phase 1 — smoke gate (baseline)

Recorded in [smoke-gate-before-github-triage.md](smoke-gate-before-github-triage.md).
`npm ci`, `npm run check` (162 passed / 5 skipped), `npm run build`, `demo` (3/3 verified),
`npm audit --omit=dev` (0 vulns), `npm pack --dry-run`, and a disposable fake-provider
E2E all **passed**. The fake-provider run correctly ended `BLOCKED` (fake only completes
in `demo`), proving verifier authority. The new branch was cut after the gate was green.

## Phase 2 — interview / intake wizard

- `src/intake/interview.ts` — the engine: modes (`quick`/`standard`/`strict`), the
  question catalog, interactive prompting (via an injected `Prompter`), non-interactive
  conservative assumptions (confidence-tagged), the safety-critical blocker, and
  `applyInterview()` which folds answers into the Objective **strengthen-only** (forbidden
  paths unioned, checks added, risk raised to a floor, acceptance criteria → slice).
- `src/cli/prompter.ts` — readline-backed `Prompter` (keeps the engine stdin-free).
- `src/cli/commands/interview.ts` — `interview` command + `gatherInterview()` reused by
  `plan --interview` and `github import/run-issue`.
- Wiring: `plan --interview [mode]`, new `interview` command; `--answers <file>` for
  hermetic/scripted runs; `createPlan`/`buildPlan` thread the outcome (`riskFloor`,
  `extraSliceNotes`).
- Output: updates `.agent-loop/objective.md`, `assumptions.md`, `plan.json`.

**Guarantee:** the interview improves planning only. It never marks work done, never
relaxes a verifier guard, and in `--auto` blocks (rather than guessing) when a
safety-critical answer is missing (high-risk objective with no verification).

See [interview-intake.md](../docs/interview-intake.md).

## Phase 3 — GitHub triage + Kanban

- `src/github/client.ts` — `GhClient`: a single safe gateway for `gh`. Reads always run;
  **writes are dry-run-gated and logged**; no merge/deploy/close verb is exposed.
- `src/github/labels.ts` — configurable status + role/stage labels; run-state ↔ label and
  ↔ Kanban-column mappings.
- `src/github/triage.ts` — deterministic classification (ready / needs-info / too-risky /
  unsupported); clarification questions (reused from the interview catalog) for unclear
  issues; `triageRepo` + `applyClassification`.
- `src/github/project.ts` — best-effort GitHub Project (v2) detection + card moves;
  **graceful degradation** (warn + continue, never throw) when no board/scope.
- `src/github/watch.ts` — `watch --once` and bounded polling (lock, max-iterations,
  idempotent per-issue state, events JSONL, abortable).
- `src/github/pr.ts` — added `updatePullRequest` (upsert, never duplicate) + source-issue
  linking (`Refs #N`, never `Closes`) + checks/blocker in the body.
- `src/cli/commands/github.ts` — the `github` command group.
- Config: `github.{repo,labels,triage,project,watch}` (`src/config/config.ts`).

**Pipeline:** issue → triage (never starts work) → import → interview (if missing) →
plan → local deterministic loop → verified commits → optional draft PR → labels/board.
The local verifier remains authoritative; `run-issue` runs the identical engine under the
single-writer run lock.

See [github-triage-kanban.md](../docs/github-triage-kanban.md).

## Commands added

```
agent-loop interview [quick|standard|strict]
agent-loop plan ... --interview [quick|standard|strict] [--answers <file>]
agent-loop github triage    --repo o/n [--dry-run|--apply] [--issue N] [--comment] [--all] [--mode m]
agent-loop github import     --repo o/n --issue N [--interview [mode]]
agent-loop github run-issue  --repo o/n --issue N [--auto] [--apply] [--pr] [--project] [--interview]
agent-loop github watch      --repo o/n [--once] [--dry-run|--apply] [--interval N] [--max-iterations N]
agent-loop github project    [sync] --repo o/n [--issue N] [--status <column>]
agent-loop github pr         create|update --repo o/n [--issue N] [--push] [--no-draft] [--dry-run]
```

## Tests added

- `test/unit/interview.test.ts` — 14 tests: mode selection, interactive (scripted) +
  auto assumptions, safety-critical block + resolution, idea/PRD + interview → valid
  plan, never-remove-built-in-forbidden-paths, editable-then-valid plan, clarification
  prompts.
- `test/integration/github-triage.test.ts` — 17 tests (hermetic `gh` stub):
  classification, dry-run no-writes vs apply, clarification comments, trigger-label
  filtering, project detect/move/fallback, PR upsert/dedupe, idempotent `watch --once`,
  polling max-iterations, duplicate-watcher prevention, and no merge/deploy/close
  verb/construction.
- `test/integration/github-e2e.test.ts` — 2 tests: the full combined chain via the real
  `github run-issue` command (triage → import → interview → plan → run fake → verify →
  commit → draft PR → labels + project → report), hermetic.

## Safety properties (asserted by tests)

- Triage/watch/project default to **dry-run**; every write is logged.
- **No** `gh pr merge`, deploy, or `gh issue close` exists in the github modules.
- Interview only **strengthens** safety (union/add/raise); built-in forbidden paths
  (`.env`, `secrets/**`, `.git/**`, …) are never removed.
- Completion stays `verified-completed/total`; the agent cannot mark work done.

## Limitations (honest)

- GitHub **Projects (v2)** sync is best-effort: requires `gh` project scope, a
  single-select status field (`github.project.statusField`), and column names matching the
  suggested statuses; otherwise it warns and continues with labels/PRs.
- `triage` lists open issues up to a limit (default 50) and filters trigger labels locally
  (OR semantics); very large backlogs are not paginated.
- Live GitHub is **not** exercised in CI (hermetic stubs only); an opt-in live dry-run is
  documented.
- Interview planning remains deterministic (no model-driven slicing) — consistent with
  the existing "planner provider is accepted but not executed" limitation.

## Adversarial safety audit

A 4-lens adversarial audit (outward-actions / verifier-integrity / injection /
correctness; 17 agents, every finding independently re-verified) was run over the new
code. Confirmed real findings were fixed:

- **Risk floor (most important).** A declared/`--answers` risk no longer sets a story's
  risk directly; it is applied as a FLOOR in `buildPlan` (raises over the heuristic). A
  high-risk goal tagged "low" still plans as high and still trips the safety-critical
  block. Regression-tested.
- **GraphQL injection surface.** The Project status-field name is now a GraphQL variable,
  not string-interpolated.
- **Label-op robustness.** `ensureLabel` before `addLabels`, best-effort `removeLabels`,
  and per-issue try/catch so one issue's write failure can't crash a triage/watch pass.
- **run-issue lock ordering.** The run lock is acquired before any GitHub writes.
- **`--answers` coercion.** Malformed answer files degrade gracefully.

Findings left as by-design (documented): the standalone `pr create` is an explicit
apply-by-default action (no `--force`; the new `github pr`/`run-issue` paths honor
`--dry-run`); project-sync `ok` in dry-run is disambiguated by the `dryRun` flag.

## Status

Baseline smoke gate passed; interview + GitHub triage/Kanban implemented, tested
hermetically, and adversarially audited; full `npm run check` (197 passed / 5 skipped) +
build + demo + audit (0 vulns) + pack green. Product status is unchanged: **limited
production with mandatory human review** — the additions are local-first and safety-first
and introduce no auto-merge/deploy/issue-close path.
