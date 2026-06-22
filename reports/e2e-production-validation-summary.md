# agent-loop — E2E Production-Validation Summary

**Branch:** `e2e-production-validation` (from `release-candidate-hardening`)
**Date:** 2026-06-22
**Validator:** independent release-validation engineer

## 1. Overall verdict

> ## RELEASE CANDIDATE  (post-fix)
> **Production ready: NO.**

The deterministic harness is strong and, for **browser** and **GitHub**, live-proven.
The as-received branch contained real defects — including a **remote-code-execution
vector** and a **silently-ignored security config** — which are now fixed and
regression-tested. The product's core value (driving a **real** AI agent autonomously)
is proven only hermetically; a live paid run was deliberately not executed.

| Standard | Met? |
| --- | --- |
| NOT READY | no |
| BETA | exceeded |
| **RELEASE CANDIDATE** | **yes (this branch, post-fix)** |
| PRODUCTION READY | no — real-provider execution not proven; fixes are fresh |

## 2. Feature-by-feature (condensed; full table → `docs/e2e-test-matrix.md`)

| Feature | Workflow tested | Command | Expected | Actual | Status | Evidence | Remaining risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Install/build/audit | clean | `npm ci && npm run check && npm run build && npm audit --omit=dev` | green, 0 prod vulns | 162 pass/5 skip, 0 vulns | PASS | `reports/e2e-evidence/01,02,03,10` | none |
| Packaging | pack | `npm pack --dry-run`, `verify:pack` | no test/secret leak | clean (263 files) | PASS | `…/04,05` | ships maps+audit doc; no LICENSE |
| CLI version | `--version` | `agent-loop --version` | package version | `0.2.0-rc.1` | BROKEN→FIXED | repro | none |
| Demo | one-shot | `agent-loop demo` ×2 | COMPLETED 3/3 | COMPLETED, scoped commits | PASS | `…/07,08,12` | none |
| Fake-provider flow | init→plan→run | `init`/`plan --idea`/`run --auto` | commit only after verify | COMMIT after VERIFICATION_PASSED | PASS | `…/fake-flow` | none |
| `logs` | view logs | `agent-loop logs` | structured logs | event log (was empty) | BROKEN→FIXED | `e2e-hardening` | none |
| Input types | all modes | `plan --idea/--prd/--spec/--readme/--stdin/--issue` | detected, valid DAG | ✓; bad input now rejected clearly | PASS / FIXED | `…/input-types` | issue path also live-proven |
| Watcher | attach/detach/modes | `watch --once/--json/--plain/--no-color` | accurate, CI-safe | ✓; progress = verified/total | PASS | `…/watcher` | interactive-TTY paths PARTIAL |
| Control flow | pause/resume/stop/retry | `agent-loop pause/resume/stop/retry` | gated, consistent | ✓ | PASS | `…/control-flow` | none |
| Stale control intent | next run | prior `stop`/`pause` then `run` | unaffected | cleared at start (was sabotaging) | BROKEN→FIXED | `e2e-hardening` | none |
| Verifier safety (18) | crafted bad diffs | `run --auto` + fake/stub | block/fail, no commit | all correct verdicts | PASS | `…/verifier-safety` | see below |
| Secret block+redact | AWS/PAT/RSA key | `run --auto` | block, redacted everywhere | ✓ literal absent from db/logs/reports/TUI | PASS | first-hand repro | non-patterned secret in allowed path (heuristic) |
| `.git` hook RCE | planted/agent hook | `run --auto` | never executes | neutralized + slice BLOCKED | BROKEN→FIXED | first-hand repro + `e2e-hardening` | none |
| config `riskPolicy` | hardening in config.yml | `run --auto` | forbidden paths honored | honored (was ignored) | BROKEN→FIXED | first-hand repro + `e2e-hardening` | none |
| Crash recovery (16) | SIGINT/TERM/kill -9 | inject + `status`/`run`/`retry` | no false completion/dupes/corruption | ✓; stale-lock self-heal | PASS | `…/crash-recovery` | PID-reuse false refusal (low) |
| Multi-provider | distinct roles/models/parallel/fallback/consensus | stub argv records | exact invocation | ✓ all hermetic | PARTIAL | `…/multi-provider` | real models not run |
| Browser verify | CDP + HTTP | `run --auto` w/ `browser.enabled` | real PNG, required-block, advisory-pass, cleanup | ✓ **live Chrome** | PASS | `…/browser-verify` | concurrency>1 (use 1) |
| GitHub PR | draft/dedupe/push/no-merge | `pr create [--push]` | draft, no auto-merge | ✓ **live throwaway repo** | PASS | `…/github` | none |
| Docs accuracy | claims vs source | run each | accurate, honest | 5 overclaims fixed | BROKEN→FIXED | `…/docs-accuracy` | none |
| Prod simulation | realistic app | `plan --idea`+`run --auto` | scoped commit, app works | COMPLETED, app passes 9 tests | PASS | `…/prod-sim` | none |
| Real AI-provider live | claude/codex worker | `run --auto` | live commit | not run (token cost) | PARTIAL | doctor (CLIs present) | unproven live |

## 3. All commands run

See `docs/e2e-production-validation.md` §7 for the full battery and
`reports/e2e-evidence/` for per-area logs. Final battery:

```bash
npm ci
npm run check                          # 27 files, 162 passed, 5 skipped
npm run build
node dist/bin/agent-loop.js demo       # COMPLETED 3/3
npm audit --omit=dev                   # 0 vulnerabilities
npm pack --dry-run                     # 263 files, no source/test/config leak
```

## 4. All failures found

13 fixed + 9 documented limitations. The HIGH ones:

1. **`.git` hook RCE** — a git hook executed during agent-loop's own commit (poisoned repo / agent-planted). **FIXED** (hooks neutralized on every git call + `.git` write detection).
2. **`config.riskPolicy` silently ignored** — security hardening had no effect. **FIXED** (merged into the plan).
3. **Stale `control.json` sabotages the next run** — silent CANCEL/hang. **FIXED** (reset at run start).
4. **`--version` reported `0.1.0`** (package `0.2.0-rc.1`). **FIXED**.
5. **Bad PRD input → bogus plan / crash** (empty/array/null/invalid). **FIXED** (boundary validation).
6. **Secrets in `secrets/`/`credentials/` committed undetected**. **FIXED** (hardened default forbidden paths; content scanner documented as heuristic; residual generic-content gap documented).
7. **Docs overclaim** — "tracked-by-default" files are git-ignored; `doctor` doesn't check `gh`; stale "browser unwired" claims. **FIXED** (docs corrected).

Full list with severities → `docs/e2e-production-validation.md` §4.

## 5. Fixes made

13 source/doc fixes across `git/repo.ts`, `orchestrator/{executor,control,planning,run}.ts`,
`cli/{index,intake-input,commands/control,commands/info}.ts`, `domain/schemas.ts`,
`intake/normalize.ts`, `git/worktree.ts`, README + 3 docs, eslint config. Detail →
`docs/e2e-production-validation.md` §5.

## 6. Tests added

`test/unit/hardening-unit.test.ts` (7) + `test/integration/e2e-hardening.test.ts` (7)
= **+14 regression tests**, one per fix. Suite: **162 passed / 5 skipped**.

## 7. Status of the high-value live paths

- **Real-provider (claude/codex/opencode) live execution:** **PARTIAL — not proven
  live.** CLIs installed (`codex-cli 0.141.0`, `Claude Code 2.1.172`); exact
  command/model/parallel/fallback/consensus construction proven hermetically. A live
  paid run was deliberately **not** executed to avoid spending the user's tokens.
- **Browser verification:** **PASS (live)** — real headless Chrome via CDP.
- **GitHub integration:** **PASS (live)** — real throwaway repo, draft PR, dedupe,
  cleanup; `gh` authenticated.

## 8. Fastest way to try it

```bash
cd /Users/abtrk/Dev/loop/agent-loop
npm ci && npm run build
node dist/bin/agent-loop.js demo      # throwaway repo → COMPLETED, no API keys
```

## 9. Recommendation

**Use for beta projects.** Promote to **limited production with mandatory per-PR human
review** only after a real-provider live smoke test on your own setup, with
`concurrency: 1` when browser verification is enabled and project-specific
`riskPolicy.globalForbiddenPaths` for any secret-bearing layout. **Do not** use
unattended/auto-merge.

- Do not use yet — ✗
- Use only in sandbox — (the `demo` path, yes)
- **Use for beta projects — ✓ (recommended)**
- Use for limited production with review — ✓ *after a real-provider smoke test*
- Use freely in production — ✗
