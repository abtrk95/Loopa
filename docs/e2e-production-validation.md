# agent-loop — End-to-End Production Validation

**Role:** independent release-validation engineer.
**Branch:** `e2e-production-validation` (cut from `release-candidate-hardening`).
**Method:** every documented feature exercised against the **built** CLI
(`node dist/bin/agent-loop.js`) in disposable `/tmp` git repos, or proven at the
source level with a real command. Nothing was taken on trust from prior reports,
README claims, or test names. 12 validation areas were run in parallel; the highest-
stakes findings (secret redaction, the `.git` hook RCE, the silently-ignored risk
policy) were additionally reproduced first-hand by the validation lead.

**Overall verdict: RELEASE CANDIDATE** (post-fix).
**Production ready: NO.**

> The deterministic harness — evidence-based completion, scoped/verified commits,
> redaction, crash recovery, browser verification, GitHub PR creation — is strong and,
> for browser and GitHub, **live-proven**. But the branch as received contained real
> defects, including a **remote-code-execution vector** (git hooks executing during
> agent-loop's own commits) and a **silently-ignored security config**. Those are now
> fixed and regression-tested. The product's core value proposition — driving a **real**
> AI coding agent autonomously through the loop — was **not** exercised live (doing so
> spends the user's API tokens); that path is proven only hermetically. See
> [Classification](#classification).

Raw evidence: `reports/e2e-evidence/`. Feature-by-feature table:
[e2e-test-matrix.md](e2e-test-matrix.md). Executive summary:
[../reports/e2e-production-validation-summary.md](../reports/e2e-production-validation-summary.md).

---

## 1. Environment

| Item | Value |
| --- | --- |
| OS | macOS (darwin 25.3) |
| Node | v22.22.1 (≥ 22.5 ✓, built-in `node:sqlite`) |
| git | 2.54.0 |
| Package | `agent-loop@0.2.0-rc.1` (`private: true`, no LICENSE) |
| Real provider CLIs present | `codex-cli 0.141.0`, `Claude Code 2.1.172` (auth not verified without spend) |
| `gh` | authenticated (`abtrk95`) — enabled the live GitHub test |
| Chrome | present — enabled the live CDP browser test |

## 2. What was validated

Installation · build · packaging · CLI usability · init · planning (all input
types) · execution · watcher/dashboard · pause/resume/stop/retry · fake-provider
flow · multi-provider routing (hermetic) · verifier safety matrix (18 scenarios) ·
secret redaction · browser verification (live Chrome + HTTP) · git safety · GitHub
integration (live) · crash recovery (16 fault-injections) · documentation accuracy
· realistic production simulation.

## 3. Headline results

- **The deterministic core is real and holds up.** Completion is computed only from
  `verifiedCompleted / totalSlices` over the event log (`projection.ts:317`), never
  from agent claims; a slice reaches `COMPLETED` only after the verifier passes and a
  scoped commit with an `agent-loop-slice:` trailer exists. Self-commits are detected
  and rolled back; resume re-verifies commit safety (the trailer is untrusted).
- **Secret handling works end-to-end (verified first-hand).** A planted AWS key →
  run `BLOCKED`, **no commit**, and the literal appears in **none** of the SQLite
  store, JSONL mirror, logs, reports, context packs, or any CLI surface; the blocker
  report shows `***REDACTED***`.
- **Browser verification is live-proven** with real headless Chrome (CDP): genuine
  PNG screenshots + console-error capture, advisory-by-default, required-blocks,
  runs only after a verifier pass, reliable timeout cleanup.
- **GitHub integration is live-proven** against a real throwaway repo: draft PR by
  default, dedupe, push only with `--push`, **no merge/deploy path**, then cleaned up.
- **Crash recovery is robust** across 16 SIGINT/SIGTERM/`kill -9` injections: no
  false completion, no duplicate commits, no SQLite corruption, stale-lock self-heal.

…but the branch as received also had the defects in §4.

## 4. Bugs found

Severity reflects impact on safety / correctness / documentation-truth.

### Fixed in this branch (with regression tests)

| # | Sev | Bug | Root cause | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | **HIGH (security)** | A git hook (`.git/hooks/*`) executes during agent-loop's own scoped commit — RCE from a poisoned repo or an agent-planted hook; `git status` never shows `.git/`, so scope/structural scans miss it. | `GitRepo` ran `git commit`/`cherry-pick` with hooks enabled; structural scan only sees `git status` paths. | Every agent-loop git call runs `-c core.hooksPath=/dev/null` (neutralize); executor snapshots the hooks dir and **BLOCKS** a slice that mutates it (detect). | `e2e-hardening.test.ts` (hook not fired; agent `.git` write blocked) |
| 2 | **HIGH** | `config.yml` `riskPolicy` (forbidden paths, lockfile/dep policy, diff ceiling) is **silently ignored** — security hardening that validates but does nothing. | `createPlan` never merged `config.riskPolicy` into the plan; the verifier reads `plan.riskPolicy`. | `mergeRiskPolicy()` folds config into the objective before the plan is built (scalars from config; forbidden globs **unioned** so defaults are never lost). | `e2e-hardening` + `hardening-unit` |
| 3 | **HIGH** | A stale `control.json` (`stopped`/`paused`) from a **prior** process silently CANCELs or hangs the **next** `run`. | The control file is never reset; a new run inherits old intent. | `ControlPlane.clear()` invoked in `executeRun` at the start of every fresh `run`/`retry` (live pause/stop still works). | `e2e-hardening` |
| 4 | HIGH (truth) | `--version`/`--help` report `0.1.0` while the package is `0.2.0-rc.1`. | Hardcoded `VERSION = '0.1.0'`. | Read `version` from `package.json` at runtime (dist + src paths). | `hardening-unit` + `e2e-hardening` |
| 5 | HIGH | Empty Markdown, a JSON **array**, JSON `null`, or invalid-JSON PRD silently produces a **bogus plan** (exit 0) or crashes with a raw `TypeError`. | No boundary validation in intake. | Typed `IntakeError` for empty / non-object / no-goal-no-stories / invalid JSON; clear "cannot read --prd …"; `--issue` requires a positive integer. | `hardening-unit` + `e2e-hardening` |
| 6 | HIGH (security) | Secrets in conventional locations (`secrets/`, `credentials/`, …) are committed **undetected** (not in default forbidden paths; content scanner is pattern-only). | Narrow default `globalForbiddenPaths`; regex deny-list misses non-patterned secrets. | Hardened default forbidden paths (`secrets/**`, `credentials/**`, `**/.env`, key files, `.git-credentials`, `.netrc`, `.pgpass`, …); docs now state the content scanner is heuristic. Residual generic-content gap documented. | `e2e-hardening` |
| 7 | HIGH (truth) | Docs say the "durable four" (`config.yml`/`plan.json`/…) are tracked-by-default; `init`'s blanket `.agent-loop/` git-ignore makes them un-committable. | Parent-directory ignore defeats the inner `.gitignore` negations. | README corrected: `.agent-loop/` is local run state, **not** committed; only `init`'s `.gitignore` change needs committing. | docs |
| 8 | MED | `agent-loop logs` is permanently "No logs yet." for normal runs (file log only carries warn/error). | `cmdLogs` only reads the file log. | Falls back to the append-only event store (one line per event). | `e2e-hardening` |
| 9 | MED | `github-integration.md` claims `doctor` reports `gh` availability — it doesn't. | stale doc. | corrected. | docs |
| 10 | MED | `architecture.md` + `reference-analysis.md` call the browser verifier "unwired / not a real browser" — contradicts the shipped CDP verifier. | stale docs. | corrected. | docs |
| 11 | MED | Bad `--prd`/`--spec`/`--readme` file paths leak raw `fs` exceptions. | unguarded `readFileSync`. | typed `IntakeError` with cause. | `e2e-hardening` |
| 12 | MED | Parallel runs leak orphan `aloop-wt/*` branches (worktree dir removed, branch left). | `WorktreePool.release` deleted only the dir. | also `deleteBranch` (its commit is already integrated). | covered by `parallel`/recovery suites |
| 13 | LOW | `doctor` shows a green ✓ for an absent non-fake provider. | ternary forced ✓. | distinct non-failing `!` advisory marker. | doctor spot-check |

### Found and documented as known limitations (not fixed — by design / out of scope)

| Sev | Limitation | Why not fixed here |
| --- | --- | --- |
| MED | `roles.planner` provider is **dead config** — the planner role is never executed; slicing is fully deterministic. | Wiring a model-driven planner is a **feature**, not a fix. Now honestly documented. |
| MED | Custom (non-preset) providers cannot be model-pinned on the CLI (`model=null` in argv). | Needs a config-level model-flag mapping — a feature. Documented. |
| LOW | `<cmd> --help` prints global help (no per-command help). | UX nicety; help is still shown. |
| LOW | `watch --json` error path emits non-JSON; no terminal-resize listener (self-corrects on refresh); live `watch` on a BLOCKED run doesn't self-terminate. | Cosmetic/interactive-only. |
| LOW | Agent-created branches/tags persist undetected; binary "flag" findings not surfaced in reports/events. | Not a commit-integrity or RCE issue. |
| LOW | CDP screenshots are image bytes — an on-screen secret would appear in the PNG (text artifacts are redacted). | Inherent to screenshots. |
| LOW | `PR_CREATED` audit event is in SQLite but not mirrored to `events.jsonl`. | Audit record exists; mirror is cosmetic. |
| LOW | Run lock can falsely refuse if an unrelated live process reused the holder PID (recorded `runId` not used to disambiguate). | Rare; conservative (refuses rather than double-runs). |
| INFO | Package ships 122 source-maps + a 226 kB internal audit doc; no LICENSE (`private:true`). | Not published; cosmetic for an unpublished RC. |

## 5. Fixes made (source)

| File | Change |
| --- | --- |
| `src/git/repo.ts` | `-c core.hooksPath=/dev/null` on every git call; `gitHooksFingerprint()` via `--git-common-dir`. |
| `src/orchestrator/executor.ts` | snapshot hooks on clean tree; **BLOCK** a slice that mutates `.git/` hooks. |
| `src/cli/index.ts` | `VERSION` read from `package.json` at runtime. |
| `src/orchestrator/control.ts` | `ControlPlane.clear()`. |
| `src/cli/commands/run.ts` | clear stale control intent at the start of `executeRun`. |
| `src/orchestrator/planning.ts` | `mergeRiskPolicy()` — fold `config.riskPolicy` into the plan. |
| `src/domain/schemas.ts` | hardened default `globalForbiddenPaths`. |
| `src/intake/normalize.ts` | boundary validation (empty / non-object / no-goal / invalid JSON). |
| `src/cli/intake-input.ts` | typed file-read errors; `--issue` positive-integer guard. |
| `src/cli/commands/control.ts` | `logs` falls back to the event store. |
| `src/cli/commands/info.ts` | `doctor` non-failing `!` marker for absent providers. |
| `src/git/worktree.ts` | delete the per-slice worktree branch on release. |
| `docs/*`, `README.md` | doc-truth corrections (see §4). |
| `eslint.config.js` | ignore `reports/` (evidence, not source). |

## 6. Tests added

- `test/unit/hardening-unit.test.ts` — version == package.json; `mergeRiskPolicy`
  unions forbidden globs + takes config scalars; intake rejects empty/array/null/
  invalid/empty-object PRDs and accepts valid ones. (7 tests)
- `test/integration/e2e-hardening.test.ts` — planted hook does **not** fire and the
  slice still completes; an agent `.git/` write is BLOCKED; config `riskPolicy` is
  honored (and the same write completes without it); a cleared control plane lets a
  previously-stopped run complete; real-CLI `--version`, `logs` (surfaces events),
  and bad-input rejection. (7 tests)

Suite after fixes: **27 files, 162 passed, 5 skipped** (`+14` new). The 5 skipped are
opt-in real-provider / live-CDP probes.

## 7. Commands run (representative)

```bash
# Phase 1 — install / build / package
npm ci
npm run check                      # 162 passed / 5 skipped
npm run build
npm audit --omit=dev               # 0 vulnerabilities
npm pack --dry-run ; npm run verify:pack
node dist/bin/agent-loop.js --version   # 0.2.0-rc.1 (post-fix)
node dist/bin/agent-loop.js --help
npm link && agent-loop demo && npm rm -g agent-loop

# Phase 2 — demo
node dist/bin/agent-loop.js demo        # COMPLETED 3/3 (run twice)

# Phase 3-4 — user flow / inputs (in disposable /tmp repos)
agent-loop init --root <repo>
agent-loop plan --idea "…" --root <repo>
agent-loop plan --prd <f.json|f.md> --spec <f> --readme <f>
… | agent-loop plan --stdin
agent-loop run --auto --root <repo>
agent-loop status|inspect|logs|diff --root <repo>

# Phase 5-6 — watcher / control
agent-loop watch --once|--json|--plain|--no-color --root <repo>
agent-loop pause|resume|stop|retry --root <repo>

# Phase 7-8 — safety / crash (fake provider + stubs, fault injection)
# secret-block repro: AWS key → BLOCKED, redacted everywhere, no commit
# .git hook repro: planted post-commit → (pre-fix fired) → (post-fix neutralized)
# config riskPolicy repro: secrets/** → (pre-fix committed) → (post-fix BLOCKED)
kill -INT/-TERM/-9 <orchestrator> ; agent-loop status ; agent-loop run --auto

# Phase 10-11 — browser (live Chrome) / GitHub (live throwaway repo)
# CDP PNG + console capture ; required-block ; advisory-pass ; timeout cleanup
# gh: draft PR, dedupe, push-only-with-flag, no merge/deploy, then cleanup

# Final battery
npm ci && npm run check && npm run build
node dist/bin/agent-loop.js demo
npm audit --omit=dev && npm pack --dry-run
```

## 8. Live-execution status

| Capability | Status | Note |
| --- | --- | --- |
| Browser verification | **PASS (live)** | real headless Chrome via CDP |
| GitHub PR flow | **PASS (live)** | real throwaway repo, created + deduped + cleaned up |
| Crash recovery | **PASS (live)** | 16 real fault injections |
| Multi-provider routing | **PARTIAL** | hermetic stubs prove exact provider/model/parallel/fallback/consensus; not run with real models |
| Real AI-provider autonomous run | **PARTIAL — not proven live** | `claude`/`codex` CLIs are installed; a live run was **deliberately not executed** to avoid spending the user's API tokens and running an unsupervised paid agent |

## 9. Classification

Using the task's standard:

- **Not PRODUCTION READY** — the bar requires *real-provider execution proven*; it is
  not (by deliberate choice). Several HIGH defects (incl. an RCE) existed in the
  as-received branch; they are fixed but the fixes are fresh.
- **RELEASE CANDIDATE** — met: all local flows, safety matrix, packaging, docs,
  browser (live), GitHub (live), and multi-provider (hermetic) pass; real-provider
  live execution is *clearly optional / opt-in*. This is the correct classification
  **after** the fixes in §5.

> Caveat: the as-received `release-candidate-hardening` branch was **not** RC-clean —
> it shipped an RCE (git hooks) and a dead security config (`riskPolicy`). The RC
> verdict applies to `e2e-production-validation` (this branch) only.

## 10. Recommendation

**Use for beta projects** — and only for **limited production with mandatory human
review of every PR** once you have (a) run a real-provider live smoke test on your own
setup and (b) confirmed it on your repos. Concretely:

- ✅ Safe to demo (the `demo` path is excellent and credential-free).
- ✅ Safe for beta use on non-critical repos with the fake provider or a supervised
  real provider, reviewing every resulting branch/PR.
- ⚠️ Limited production **only with** per-PR human review, `concurrency: 1` if browser
  verification is on, project-specific `riskPolicy.globalForbiddenPaths` for any
  secret-bearing layout, and after a real-provider smoke test.
- ❌ Not for unattended/auto-merge production use — real-agent behavior through the
  loop is unproven at scale and auto-merge/deploy are intentionally absent.

The deterministic safety harness is the product's strongest asset and is now sound;
the remaining risk is operational (real-agent quality) plus the documented
limitations — not core-correctness risk.
