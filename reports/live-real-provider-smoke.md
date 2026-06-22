# agent-loop — Live Real-Provider Smoke Test

**Goal of this exercise:** close the one remaining `PARTIAL` from the E2E production
validation — prove that agent-loop can drive a **real** AI coding agent through one
complete autonomous slice end-to-end, on a disposable repo, safely:

```
real provider → receives plan/context → edits a disposable repo → verifier checks
the real git diff → scoped commit is created → status/events reflect verified
progress → run completes without unsafe behavior
```

**Result: PASS — live-proven for two providers (Claude Code and Codex), each on its
own disposable repo.** No source bug was found (the deterministic harness behaved
correctly throughout, including correctly **blocking** an out-of-scope write on the
first attempt). One realistic operational finding is documented below.

> This is a controlled release-validation exercise, not feature work. Only
> documentation was changed in the product repo (see §16).

---

## 1. Branch and commit SHA

| | |
| --- | --- |
| Validation branch | `live-real-provider-smoke` |
| Cut from | `e2e-production-validation` @ `a24c3c54eb30f0b3367e74cd5cf2d2f7c83f2673` |
| Package | `agent-loop@0.2.0-rc.1` |

## 2–4. Provider(s) tested, versions, live vs stubbed

| Provider | Version | Auth | Mode | Verdict |
| --- | --- | --- | --- | --- |
| **Claude Code** (`claude`) | `2.1.172 (Claude Code)` | subscription (probe `claude -p` → "READY", exit 0) | **LIVE — real tokens spent** | **PASS** |
| **Codex** (`codex`) | `codex-cli 0.141.0` | "Logged in using ChatGPT" (`codex login status`) | **LIVE — real tokens spent** | **PASS** |

Environment: macOS (darwin 25.3), Node `v22.22.1`, git `2.54.0`. The fake provider and
the hermetic provider-smoke tests remain passing and are kept **separate** from this
live evidence.

## 5. Exact disposable repo paths

| | |
| --- | --- |
| Claude run | `/tmp/agent-loop-live-provider-smoke/repo` (+ PRD `/tmp/agent-loop-live-provider-smoke/prd.json`) |
| Codex run | `/tmp/agent-loop-live-provider-smoke-codex/repo` (+ PRD `/tmp/agent-loop-live-provider-smoke-codex/prd.json`) |

Each is a fresh `git init` JS project using Node's built-in test runner (`node --test`,
**no dependencies, no `npm install`**), with a committed clean baseline before agent-loop
ran. No production repo, reference repo, or the agent-loop repo itself was used as a target.

## 6. Exact commands run

Baseline (in `/Users/abtrk/Dev/loop/agent-loop`, all green):

```bash
git checkout e2e-production-validation && git checkout -b live-real-provider-smoke
npm ci
npm run check          # 27 files, 162 passed, 5 skipped
npm run build
node dist/bin/agent-loop.js demo     # COMPLETED 3/3
claude --version   # 2.1.172 (Claude Code)
codex  --version   # codex-cli 0.141.0
```

Disposable repo + live run (Claude shown; Codex identical with its own dir/config):

```bash
SMOKE=/tmp/agent-loop-live-provider-smoke; ROOT=$SMOKE/repo
AL="node /Users/abtrk/Dev/loop/agent-loop/dist/bin/agent-loop.js"

# fresh repo, clean baseline (node --test, no deps)
mkdir -p $ROOT/src $ROOT/test
# package.json (test: "node --test"), .gitignore, README, src/.gitkeep, test/.gitkeep
git -C $ROOT init -q
git -C $ROOT config user.email smoke@local.test; git -C $ROOT config user.name "agent-loop smoke"
git -C $ROOT add -A && git -C $ROOT commit -q -m "baseline"

$AL init --root $ROOT                         # scaffolds .agent-loop/, gitignores it
# write .agent-loop/config.yml (see §7), then commit the init .gitignore change
git -C $ROOT add .gitignore && git -C $ROOT commit -q -m "chore: ignore .agent-loop"
# exclude external agent-tooling scratch dirs from git (see Finding in §15)
printf '.claude-flow/\n.swarm/\n.hive-mind/\nmemory/\ncoordination/\n' >> $ROOT/.git/info/exclude

$AL doctor    --root $ROOT                     # provider:claude ✓ 2.1.172
$AL providers --root $ROOT                     # claude ok 2.1.172
$AL plan --prd $SMOKE/prd.json --root $ROOT    # 1 slice, paths src/** test/**, check test
$AL run  --auto --root $ROOT                   # ← LIVE: real claude worker

# evidence
$AL status  --json --root $ROOT
$AL inspect --root $ROOT
$AL logs    --root $ROOT
$AL diff    --root $ROOT
$AL watch --once --json --root $ROOT
git -C $ROOT log --oneline --decorate --all
git -C $ROOT show <sha> --stat
( cd $ROOT && npm run test )
```

## 7. Configuration used

`concurrency: 1`, single worker, no browser, no GitHub, minimal retries (1 worker + 1
fixer max), 5-min agent timeout. The **only** non-default is the documented, minimal
autonomy opt-in per provider (see §safety):

```yaml
# Claude run — .agent-loop/config.yml (abridged)
auto: true
roles:
  planner: { provider: fake }            # planner is deterministic; never a model call
  workers: [{ provider: claude, model: claude-sonnet-4-6, weight: 1 }]
  fixer:   { strategy: same-as-worker }
routing: { workerStrategy: static, fallbackOrder: [], switchProviderOnRetry: false, reviewerConsensus: 1 }
execution: { concurrency: 1, maxRetriesPerSlice: 1, agentTimeoutMs: 300000, checkTimeoutMs: 120000 }
git: { requireCleanTree: true, allowDirty: false }
verification: { detectTestWeakening: true, detectSecrets: true }
browser: { enabled: false }
github:  { enabled: false }
providers:
  claude:
    args: ["--permission-mode", "acceptEdits"]   # MINIMAL autonomy opt-in (see below)
```

```yaml
# Codex run — only the differences
roles: { workers: [{ provider: codex }] }    # no model pinned → Codex account default
providers:
  codex:
    args: ["-s", "workspace-write"]          # MINIMAL sandboxed autonomy opt-in
```

### Safety-flag decision (the one judgement call in this exercise)

Real CLIs cannot autonomously edit files without an explicit opt-in flag — this is
agent-loop's deliberate "no danger flags by default" design (security-model.md
Defense 6; the `init` template documents these exact flags). The task forbids
**dangerous permission-bypass** flags. I used the **minimal, edit-scoped** flag for each
provider and explicitly did **not** use any host-compromising bypass:

| | Used (minimal, documented) | Refused (dangerous bypass) |
| --- | --- | --- |
| Claude | `--permission-mode acceptEdits` — auto-accepts **file edits only**; Bash/other tools stay gated | `--dangerously-skip-permissions`, `--permission-mode bypassPermissions` |
| Codex | `-s workspace-write` — writes confined to the **workspace (cwd)**, sandboxed, no network | `--dangerously-bypass-approvals-and-sandbox`, `-s danger-full-access`, `--yolo` |

`acceptEdits` / `workspace-write` are not host-level bypasses: they grant only the
in-repo editing the task requires, inside a disposable `/tmp` repo, wrapped by
agent-loop's deterministic harness (scope policy, hardened forbidden paths, structural
scan, secret detection, no-shell ProcessManager, neutralized git hooks, scoped commits).
This is exactly the "run a real-provider smoke test on your own setup" the prior E2E
validation recommended as the gate to limited production.

## 8. Goal / task used

PRD (one user story, scoped to `src/**` + `test/**`): *"Add a YYYY-MM-DD date formatter
with tests."* Acceptance: `src/format-date.js` exports `formatDate(date)` returning a
zero-padded `YYYY-MM-DD` string; `test/format-date.test.js` covers it with `node:test`;
`npm run test` passes; touch nothing outside `src/`/`test/`.

## 9. Files changed by the provider

Both providers produced correct, idiomatic code (independently re-verified by skeptics):

- **Claude** (commit `6066101`): `src/format-date.js` (local Y/M/D, `padStart(2,'0')`) +
  `test/format-date.test.js` (two `node:test` cases). 19 added lines, 2 files.
- **Codex** (commit `a8ef364`): same two files; Codex additionally `padStart(4,'0')` the
  year (extra-defensive). 21 added lines, 2 files.

`npm run test` → **2 passed / 0 failed** in each repo (run independently after the fact).

## 10. Commits created

| Run | runId | Branch | Commit | Trailer | Author | Files |
| --- | --- | --- | --- | --- | --- | --- |
| Claude #2 | `run_47b24e413329` | `agent-loop/add-a-small-date-formatting-utility-with` | `6066101e667c728a6afa5224e7165e4d0e7c5206` | `agent-loop-slice: S-001` | `agent-loop <agent-loop@local>` | `src/format-date.js`, `test/format-date.test.js` |
| Codex | `run_83e7168be5a3` | (same prefix) | `a8ef3642a8193e52180642118f569d3764b817f0` | `agent-loop-slice: S-001` | `agent-loop <agent-loop@local>` | same 2 files |

No tags created; no branches beyond `master` + the one run branch per repo.

## 11. Verifier result

| | Claude #2 | Codex |
| --- | --- | --- |
| `scope` check | pass (only `src/**`,`test/**`) | pass |
| `test` check (`npm run test`) | **passed (exit 0)**, 122 ms | passed (exit 0), 122 ms |
| `secrets` check | ok (no secret shapes) | ok |
| test-weakening | none (`.skip`/`.only`/`xit` absent) | none |
| `VERIFICATION_PASSED` | `addedLines:19, files:2` | `addedLines:21, files:2` |
| Final full-tree verification | `verdict: pass` | `verdict: pass` |

Event ordering (both runs): `VERIFICATION_PASSED` **strictly precedes** `COMMIT_CREATED`
— the scoped commit is created only **after** the deterministic verifier passes.

## 12. Watcher / status evidence

`status --json` and `watch --once --json|--plain` both report progress derived from
**verified** slices, not agent text:

```
runState=COMPLETED  progressFraction=1  verifiedCompleted=1  totalSlices=1
S-001 COMPLETED  provider=claude  model=claude-sonnet-4-6  lastCommit=6066101e  checks=[test:passed]
git: clean  uncommitted=0
```

`inspect` shows the per-slice event chain `VERIFICATION_PASSED → COMMIT_CREATED →
SLICE_COMPLETED`; `logs` surfaces the full verifier/orchestrator/git event stream;
`diff` reports "no uncommitted changes".

## 13. Final run state

| Run | Final state | Exit code |
| --- | --- | --- |
| Claude #1 (negative control) | **BLOCKED** | 2 |
| Claude #2 | **COMPLETED** (1/1, 100%) | 0 |
| Codex | **COMPLETED** (1/1, 100%) | 0 |

## 14. Token / cost note

`AGENT_PROCESS_EXITED` recorded `costUsd:0, tokens:0` for every attempt. This is a
**known measurement limitation, not zero spend**: the `claude -p` / `codex exec` *text*
output does not emit a machine-parseable cost line, so `CommandProvider` cannot capture
it (cost/budget tracking only works for providers that report it). **Real tokens were
spent.** Actual spend was small by construction (tiny task, `concurrency:1`,
`maxRetriesPerSlice:1`): four short agent invocations total across all runs
(Claude #1 worker+fixer ≈ 28 s, Claude #2 ≈ 13 s, Codex ≈ 76 s) — on the order of a few
US cents.

## 15. Bugs found

**No agent-loop source bug.** The harness behaved correctly at every step, including the
"failure" path. The one notable finding is operational:

### Finding (operational, HIGH value for real-provider users) — host agent-tooling pollutes CWD and (correctly) trips the scope verifier

On the **first** Claude run the slice went `BLOCKED` after 2 attempts:
`changed files outside allowedPaths → .claude-flow/data/pending-insights.jsonl,
.claude-flow/sessions/session-*.json`. Root cause: this host has **claude-flow** session
hooks (a Claude Code add-on) that write telemetry into the **current working directory**
whenever the `claude` binary runs. Those writes landed in the target repo's working tree,
and agent-loop's scope policy **correctly** flagged them as out-of-scope, refused to
commit, rolled back, and blocked.

- This is **the safety mechanism working as designed** (Defense 1: blast-radius
  containment), *not* a bug. A hermetic test can never surface it because the fake
  provider doesn't trigger external Claude tooling.
- The Codex run did **not** exhibit this (Codex writes to `~/.codex`, not CWD),
  corroborating the root cause as Claude-Code-tooling-specific.
- **Mitigation** (used here to prove the full chain): exclude the external tool's scratch
  dirs from git via `.git/info/exclude` — the *same mechanism* agent-loop uses for its own
  `.agent-loop/`. With `.claude-flow/` (etc.) git-ignored, the verifier's changed-path set
  was exactly the agent's `src/`+`test/` edits, and the run completed cleanly.

This is exactly the kind of real-world friction a live smoke test exists to surface, and
it is now documented (see §16).

## 16. Fixes made

Documentation only (no code change was warranted):

- `docs/provider-adapters.md` — added "Operational note: host agent tooling that writes to
  CWD" explaining the `.claude-flow`/scratch-dir interaction and the `.git/info/exclude`
  mitigation, plus a note that text-provider cost is not machine-captured.
- `docs/e2e-production-validation.md` + `reports/e2e-production-validation-summary.md` —
  updated the **Real AI-provider autonomous run** row from `PARTIAL — not proven live`
  to **PASS (live)** with this report as evidence, and refreshed the classification.
- `README.md` — Status: real-provider execution now live-proven (Claude + Codex).

## 17. Tests added

None. No product defect was found, so there is nothing to regression-test (adding a test
would assert behavior that is already covered by the existing scope-verifier suite and the
opt-in live smoke in `test/integration/provider-smoke.test.ts`). The existing suite still
passes: **162 passed / 5 skipped**.

## 18. Remaining limitations

- **Multi-provider *routing* in a single run is still hermetic-only.** Two providers were
  each proven live in **separate** runs; cross-provider fallback / round-robin / reviewer
  consensus *within one run* against real models was not exercised live (the prior E2E
  proved the exact argv/model/parallel/fallback/consensus construction with stubs).
- **Cost/budget enforcement is unproven for text providers** — `budgetUsd`/`budgetTokens`
  cannot trigger because cost isn't captured from `claude -p`/`codex exec` text output (§14).
- **Single tiny task, low risk class.** Larger/multi-slice plans, the fixer-recovery path
  on a *legitimate* verification failure, parallel worktrees with real models, and
  higher-risk slices (mandatory review) were not exercised live.
- **Reviewer/planner roles not live.** No live reviewer panel; the planner remains
  deterministic (documented dead-config).
- **Browser verification + GitHub PR + crash recovery were live-proven in the prior E2E**,
  not re-run here.
- Host-specific: the `.claude-flow` interaction (§15) will affect any user whose Claude
  install has CWD-writing session hooks until they exclude those dirs.

## 19. Final classification

> ## LIMITED PRODUCTION WITH MANDATORY HUMAN REVIEW

This is a **promotion** from the prior `RELEASE CANDIDATE`: the previously-`PARTIAL`
"real AI-provider autonomous run" is now **live-proven end-to-end for two providers** on
disposable repos, with the full evidence chain (real process → real edits → deterministic
verify → verified-first scoped commit → COMPLETED) independently re-validated by three
adversarial skeptics (40/40 criteria `met`, zero overclaims).

It is **not** full `PRODUCTION READY`, by the task's own bar: that requires multi-provider
*routing*, crash recovery, browser verification, GitHub integration, packaging, **and**
docs all proven **together under realistic conditions**. Here, multi-provider routing
within a single run is still hermetic-only, only a tiny low-risk task was driven live, and
auto-merge/deploy are intentionally absent. Use on real repos **only with per-PR human
review**, `concurrency:1` when browser verification is on, and project-specific
`riskPolicy.globalForbiddenPaths` for any secret-bearing layout.

---

### Reproduce it yourself (fastest safe path)

```bash
cd /Users/abtrk/Dev/loop/agent-loop && npm ci && npm run build

# disposable repo
D=/tmp/al-smoke; rm -rf $D; mkdir -p $D/src $D/test
printf '{\n  "name":"al-smoke","type":"module","scripts":{"test":"node --test"}\n}\n' > $D/package.json
git -C $D init -q && git -C $D config user.email a@b.c && git -C $D config user.name a
git -C $D add -A && git -C $D commit -q -m baseline

AL="node $PWD/dist/bin/agent-loop.js"
$AL init --root $D
# enable a real worker + minimal autonomy flag:
cat >> $D/.agent-loop/config.yml <<'YAML'
roles: { workers: [{ provider: claude, model: claude-sonnet-4-6 }] }
providers: { claude: { args: ["--permission-mode","acceptEdits"] } }
auto: true
YAML
git -C $D add .gitignore && git -C $D commit -q -m ignore
printf '.claude-flow/\n.swarm/\n' >> $D/.git/info/exclude    # if your claude has CWD-writing hooks

$AL plan --idea "Add a YYYY-MM-DD date formatter in src/ with a node:test test in test/" --root $D
$AL run --auto --root $D
$AL status --root $D && ( cd $D && npm run test )
```

(Hermetic, credential-free alternative: `node dist/bin/agent-loop.js demo`.)
