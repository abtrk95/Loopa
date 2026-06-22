# agent-loop — E2E Test Matrix

Independent release-validation of `agent-loop`, branch `e2e-production-validation`
(from `release-candidate-hardening`). Every row was executed against the **built**
CLI (`node dist/bin/agent-loop.js`) in disposable `/tmp` repos, or proven at the
source level with a real command. Raw logs: `reports/e2e-evidence/<area>/`.

**Status legend**

| Status | Meaning |
| --- | --- |
| PASS | Live-proven working as documented. |
| PARTIAL | Hermetic/stub/test proven, not live proven (what's unproven is stated). |
| BROKEN→FIXED | Was broken; fixed + regression-tested in this branch. |
| FIXED | Defect found and corrected here (see Fixes). |
| KNOWN-LIMIT | Implemented limitation, now honestly documented. |

## Phase 1 — Install, build, packaging, CLI

| Feature | User workflow | Command | Expected | Actual | Status | Evidence | Remaining risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Clean install | fresh `npm ci` | `npm ci` | deps install, no prod vulns | 188 pkgs, 3 low (dev-only) | PASS | `01-npm-check.log` | none |
| Type+lint+test | `npm run check` | `npm run check` | all green | 27 files, **162 passed / 5 skipped** | PASS | `10-npm-check-after-fixes.log` | none |
| Build | `npm run build` | `npm run build` | dist + chmod bin | clean, `dist/bin/agent-loop.js` 0755 | PASS | `02-npm-build.log` | none |
| Prod audit | supply chain | `npm audit --omit=dev` | 0 high | **0 vulnerabilities** | PASS | `03-npm-audit-prod.log` | none |
| Package contents | `npm pack` | `npm pack --dry-run` + `verify:pack` | ship dist+docs, no tests/secrets | 263 files; no test/.env/config leak | PASS | `04-npm-pack-dryrun.log`, `05-verify-pack.log` | ships 122 source-maps + 226 kB internal audit doc; no LICENSE (`private:true`) |
| `npm link` | global install | `npm link` → `agent-loop …` | binary on PATH, clean removal | works w/o sudo; `npm rm -g` clean | PASS | `packaging-cli/` | none |
| `--version` | version check | `agent-loop --version` | package version | was `0.1.0` (hardcoded); **now `0.2.0-rc.1`** | BROKEN→FIXED | `06-cli-help.log`, repro | none |
| `--help` | usage | `agent-loop --help` | command reference | accurate banner | PASS | `06-cli-help.log` | none |
| Per-command help | `<cmd> --help` | `agent-loop plan --help` | command-specific help | prints **global** help (help short-circuits dispatch) | KNOWN-LIMIT | `06-cli-help.log` | discoverability only |
| `doctor` | env health | `agent-loop doctor` | env + provider health | accurate; absent provider now shows `!` not green ✓ | FIXED | doctor spot-check | doesn't probe `gh` (doc corrected) |
| `providers` | adapter health | `agent-loop providers --json` | list+version+health | accurate text+JSON | PASS | doctor spot-check | lists only configured providers |

## Phase 2 — Demo (no API keys)

| Feature | Workflow | Command | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Demo E2E | one command | `agent-loop demo` | throwaway repo → COMPLETED, report | COMPLETED 3/3, scoped commits + `agent-loop-slice:` trailers, report.md | PASS | `07-demo-run1.log`, `12-demo-after-fixes.log` | none |
| Demo repeatable | run twice | `agent-loop demo` ×2 | fresh repo each, COMPLETED | both COMPLETED | PASS | `08-demo-run2.log` | none |

## Phase 3 — Fake-provider user flow

| Feature | Workflow | Command | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `init` scaffold | new repo | `agent-loop init` | `.agent-loop/` + gitignore | correct layout (0700 dirs) | PASS | `fake-flow/` | none |
| `plan --idea` | idea→plan | `agent-loop plan --idea …` | 1 slice, AC, checks | well-formed S-001 | PASS | `fake-flow/05-plan.txt` | none |
| `run --auto` | execute | `agent-loop run --auto` | commit only after verify | COMMIT after VERIFICATION_PASSED (seq-ordered) | PASS | `fake-flow/` | none |
| BLOCKED-by-design | idea + no fake script | `run --auto` | ends BLOCKED, no fake success | BLOCKED, exit 2 | PASS | `fake-flow/07-blocked-run.txt` | none |
| `status`/`inspect`/`diff` | inspect | `agent-loop status`/`inspect`/`diff` | useful, evidence-based | accurate | PASS | `fake-flow/` | none |
| `logs` | view logs | `agent-loop logs` | structured logs | was always "No logs yet"; **now prints event log** | BROKEN→FIXED | `e2e-hardening` test | none |
| init gitignore | commit config | docs step | clean tree for run | `.agent-loop/` is local-ignored; docs corrected | BROKEN→FIXED | docs-accuracy | none |

## Phase 4 — Input types

| Feature | Workflow | Command | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--idea` | idea | `plan --idea` | detected | ✓ | PASS | `input-types/01-*` | none |
| `--prd .md` / `.json` | PRD | `plan --prd` | detected, DAG valid | ✓ (priority sort + dep remap) | PASS | `input-types/02,03-*` | none |
| `--spec` / `--readme` | doc | `plan --spec/--readme` | detected | ✓ | PASS | `input-types/04,05-*` | none |
| `--stdin` | pipe | `… \| plan --stdin` | sniffed | ✓ all branches | PASS | `input-types/` | none |
| `--issue` (gh stub) | issue import | `plan --issue N` | `gh issue view` | exact argv proven | PARTIAL | `input-types/` | also live-proven in GitHub area |
| empty / array / null / invalid PRD | bad input | `plan --prd bad` | clear failure | was silent bogus plan / raw crash; **now typed IntakeError, nonzero** | BROKEN→FIXED | `e2e-hardening`, `hardening-unit` | none |
| missing/`--prd` file | bad path | `plan --prd nope` | helpful error | was raw ENOENT; **now "cannot read --prd …"** | FIXED | `e2e-hardening` | none |
| `--issue` non-numeric | bad arg | `plan --issue abc` | rejected | **now rejected** (was NaN→gh) | FIXED | `intake-input.ts` | none |

## Phase 5 — Watcher / dashboard

| Feature | Workflow | Command | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--once`/`--json`/`--plain`/`--no-color` | snapshot | `agent-loop watch --…` | valid output per mode | JSON parses; non-TTY = 0 ANSI; TTY = boxed UI | PASS | `watcher/` | none |
| attach/detach/reconnect | live | bg `run` + `watch` | run unaffected | 40 attaches mid-run; verifiedCompleted 0→8; run completed | PASS | `watcher/attach_poll.log` | none |
| progress = verified/total | semantics | projection | not agent-claimed | BLOCKED run shows 2/3 (excludes claimed slice) | PASS | `projection.ts:317` | none |
| keybindings / modals / resize | TTY interactive | live keys | redraw | source-verified; not driven from real TTY | PARTIAL | `watcher/` | resize self-corrects on refresh tick |
| `watch --json` error path | error | bad runId | JSON error | emits plain text | KNOWN-LIMIT | `watcher/` | low |

## Phase 6 — Control flow

| Feature | Workflow | Command | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pause | mid-run | `agent-loop pause` | no new slice starts | gated at checkpoint | PASS | `control-flow/pause-events.log` | none |
| resume | continue | `agent-loop resume` | safe continue, no redo | ✓ | PASS | `control-flow/` | none |
| stop | terminate | `agent-loop stop` | abort + reap, clean tree | aborted ~25ms, lock released | PASS | `control-flow/` | none |
| retry | resume blocked | `agent-loop retry` | only failed/blocked retried | completed slices untouched (stable shas) | PASS | `control-flow/` | none |
| stale control.json | next run | prior `stop`/`pause` then `run` | fresh run unaffected | was silently CANCELLED/hung; **now cleared at run start** | BROKEN→FIXED | `e2e-hardening` | none |

## Phase 7 — Verifier & safety (18 scenarios)

| Scenario | Command (fake-provider/stub) | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| empty diff | no fake script | fail, no commit | ✓ | PASS | `verifier-safety/s1-*` |
| failing test / typecheck / lint | failing check cmd | fail | ✓ | PASS | `verifier-safety/` |
| out-of-scope write | narrow allowedPaths | fail, no commit | ✓ | PASS | `verifier-safety/` |
| `.env` edit | fake writes .env | block | ✓ | PASS | `verifier-safety/` |
| **secret insertion** | AWS/GitHub/RSA key | block + redacted everywhere | ✓ — literal absent from db/logs/events/reports/context; `***REDACTED***` | PASS | my repro + `verifier-safety/` |
| `.git/` write (planted hook) | exec post-commit | block + never execute | was **VULNERABLE (RCE)**; **now neutralized + slice BLOCKED** | BROKEN→FIXED | my repro + `e2e-hardening` |
| symlink escape | crafted commit | block | ✓ (commit-safety path) | PARTIAL | `verifier-safety/commitsafety-direct.json` |
| submodule (`.gitmodules`/gitlink) | fake | fail | ✓ | PASS | `verifier-safety/` |
| deleted / weakened tests | fake delete / `.skip` | fail | ✓ | PASS | `verifier-safety/s10,s11-*` |
| binary file | NUL bytes | flag | ✓ flagged | PARTIAL | `verifier-safety/s12-*` (flag not surfaced in report) |
| lockfile when forbidden | fake writes lockfile | fail | ✓ | PASS | `verifier-safety/` |
| agent self-commit | stub commits | block + undo | ✓ | PASS | `verifier-safety/s14-*` |
| agent branch/tag | stub | handled | persists undetected | KNOWN-LIMIT | `verifier-safety/` |
| merge-conflict markers | fake `<<<<<<<` | fail | ✓ | PASS | `verifier-safety/s17-*` |
| oversized diff | > maxDiffLines | fail | ✓ | PASS | `verifier-safety/` |
| reviewer cannot override verifier | all-pass reviewers + bad diff | still blocked | ✓ | PASS | `reviewer-consensus` test |

## Phase 8 — Crash recovery (16 fault-injections)

| Feature | Workflow | Command | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kill mid-run (SIGINT/TERM/-9) | inject + restart | `status`/`run`/`retry` | no false completion | never COMPLETED falsely | PASS | `crash-recovery/` | none |
| no duplicate commits | restart | idempotency keys | 1 trailer/slice | ✓ | PASS | `crash-recovery/` | none |
| no corrupted state | `kill -9` | `PRAGMA integrity_check` | ok; garbage rows skipped | ok | PASS | `crash-recovery/` | none |
| stale lock self-heal | `kill -9` then run | dead-PID takeover | "recovered a stale run lock" | PASS | `crash-recovery/C-*` | none |
| orphan worktree branches | parallel run | cleanup | leaked `aloop-wt/*`; **now deleted on release** | FIXED | `crash-recovery/`, `worktree.ts` | none |
| lock vs unrelated live PID | PID reuse | runId disambiguation | false refusal possible | KNOWN-LIMIT | `crash-recovery/` | low |

## Phase 9 — Multi-agent / multi-provider (hermetic stubs)

| Feature | Workflow | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| distinct planner/worker/reviewer/fixer | stub argv records | different providers | ✓ proven from records | PASS | `multi-provider/scenario*-records.jsonl` | none |
| per-role model passing | preset modelArgs | model in argv | ✓ | PASS | `multi-provider/` | none |
| parallel independent slices | concurrency>1 | overlap | overlapping timestamps + distinct PIDs | PASS | `multi-provider/` | none |
| overlapping scope serialize | DAG | no overlap | ✓ | PASS | `multi-provider/` | none |
| provider fallback | primary fails | secondary runs | ✓ | PASS | `multi-provider/` | none |
| switch-on-retry | attempt2 switches | different provider | ✓ | PASS | `multi-provider/` | none |
| reviewer consensus (distinct panel) | all-pass / one-block | pass / BLOCK | ✓ | PASS | `reviewer-consensus` test | none |
| reviewer cannot override verifier | unanimous pass + bad diff | blocked | ✓ | PASS | `multi-provider/` | none |
| deterministic final integration | 4 parallel slices | cherry-pick + final verify | COMPLETED | PASS | `multi-provider/` | none |
| `roles.planner` provider | configure planner | model-driven slicing | **not executed** (deterministic only) | KNOWN-LIMIT | `routing.ts:planner()` no callers | documented |
| custom provider model pin | non-preset model | model in argv | `model=null` (no preset mapping) | KNOWN-LIMIT | `multi-provider/` | documented |
| **real AI-provider live run** | `claude`/`codex` worker | live commit | CLIs installed+authed; **NOT run** (would spend tokens) | PARTIAL | doctor (codex 0.141.0, claude 2.1.172) | unproven live |

## Phase 10 — Browser verification

| Feature | Workflow | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| server start + readiness probe | fixture app | starts, probes | ✓ | PASS | `browser-verify/` | none |
| real Chrome (CDP) screenshots | `engine: auto/cdp` | real PNG + console errors | PNG magic bytes + console.error captured | PASS | `browser-verify/cdp-pass-root.png` | none |
| HTTP fallback | `engine: http` | HTML snapshot + status | ✓ | PASS | `browser-verify/cli-run-http-pass.log` | none |
| required failure blocks | `required: true` | BLOCK, no commit | ✓ | PASS | `browser-verify/cli-run-cdp-required-block.log` | none |
| advisory failure doesn't override | `required: false` | slice still COMPLETES | ✓ | PASS | `browser-verify/cli-run-cdp-advisory-fail.log` | none |
| runs only after verifier pass | empty-diff | browser never runs | ✓ | PASS | `executor.ts` | none |
| timeout cleanup | unreachable URL | server reaped, no orphan | ✓ | PASS | `browser-verify/` | none |
| secrets redacted in artifacts | text artifacts | redacted | ✓ | PASS | `browser-verify/` | CDP **screenshots** not text-redacted (inherent) |
| concurrency>1 guard | enabled + parallel | per-slice ports | no runtime guard (documented) | KNOWN-LIMIT | README | use `concurrency:1` |

## Phase 11 — GitHub integration

| Feature | Workflow | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| draft PR by default | `pr create` | `--draft` in argv | ✓ | PASS | `github/call-log-1-*` | none |
| PR body has verified results | `pr create` | slices/commits/state | ✓ real shas | PASS | `github/` | none |
| duplicate prevention | `pr create` ×2 | reuse existing | ✓ | PASS | `github/call-log-2-*` | none |
| push only with `--push` | `pr create` [--push] | no push w/o flag | ✓ | PASS | `github/call-log-3*-*` | none |
| no merge / no deploy | all invocations | only list/create/issue view | ✓ no merge/deploy verb | PASS | `github/all-verbs.txt` | none |
| **live throwaway repo** | real `gh` | draft PR + dedup + cleanup | ✓ created PR #1, deduped, closed+archived | PASS (live) | `github/live-*` | none |
| `PR_CREATED` audit | event mirror | jsonl mirror | in sqlite, **not** jsonl | KNOWN-LIMIT | `github/` | low |

## Phase 12 — Documentation accuracy

| Doc claim | Expected | Actual | Status | Fix |
| --- | --- | --- | --- | --- |
| README command table + quick-start | runs as written | ✓ (sub `node dist/bin/agent-loop.js`) | PASS | — |
| config keys = zod schema | exact match | ✓ (`.strict()`; unknown key = error) | PASS | — |
| `judge` reserved/not wired | never invoked | ✓ (`router.judge()` zero callers) | PASS | — |
| `roles.browser` reserved | unwired | ✓ | PASS | — |
| durable four "tracked-by-default" | committable | git-ignored after init (overclaim) | BROKEN→FIXED | README corrected to "local run state" |
| `doctor` reports `gh` | true | false | BROKEN→FIXED | github-integration.md corrected |
| browser "unwired / not a real browser" | stale | contradicts shipped CDP verifier | BROKEN→FIXED | architecture.md + reference-analysis.md corrected |
| secret scanner = guarantee | implied | heuristic deny-list | FIXED | security-model.md + README state it is heuristic |
| `--version` | package version | `0.1.0` | BROKEN→FIXED | reads package.json |

## Phase 13 — Production simulation

| Feature | Workflow | Expected | Actual | Status | Evidence | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| realistic app, full loop | `plan --idea` + `run --auto` | scoped commit, tests pass | COMPLETED, only intended files, app still works (9 tests pass) | PASS | `prod-sim/` | none |
| adversarial `.env` overwrite | fake writes .env | BLOCKED | ✓ (path + secret), rolled back | PASS | `prod-sim/` | none |
| secret in `secrets/` (no .env) | fake writes secrets/ | block | was **committed undetected**; **now blocked by hardened default** | BROKEN→FIXED | my repro + `e2e-hardening` | generic non-patterned secret in an *allowed* path still possible (documented) |
| config `riskPolicy` hardening | config.yml policy | honored | was **silently ignored**; **now honored** | BROKEN→FIXED | my repro + `e2e-hardening` | none |
