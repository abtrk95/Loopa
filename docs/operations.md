# Operations playbook

Day-to-day operating guide for running agent-loop against a real repository. For the
"why," follow the links into the other docs.

## Prerequisites

- Node ≥ 22.5, git on `PATH`, and a git repo to work in.
- For real agents: the provider CLI installed + authenticated (`claude`, `codex`, or
  `opencode`). For PRs: `gh` authenticated.
- Run `agent-loop doctor` first — it checks Node version, git, and provider health.

## The standard loop

```bash
cd /path/to/repo
agent-loop init                                   # once per repo
git add .agent-loop/config.yml .gitignore && git commit -m "chore: add agent-loop"

agent-loop plan --prd ./REQUIREMENTS.md           # or --idea / --issue / --stdin
#   review .agent-loop/plan.json and objective.md

agent-loop run --auto --watch                     # execute with the live dashboard
#   ...or: agent-loop run        (human approval gate; prints the plan, asks y/N)

agent-loop status                                 # verified state at a glance
agent-loop pr create --push                       # open a draft PR (optional)
```

Start the tree clean. The engine refuses to run on a dirty tree by default (rollback
uses `git clean`, which would otherwise destroy untracked files) — commit or stash first,
or set `git.allowDirty: true` if you understand the risk.

## Choosing autonomy level

- **Approval gate (default):** `agent-loop run` prints the plan and asks before executing.
  Good for the first run on a new repo.
- **Fully autonomous:** `agent-loop run --auto` (or `auto: true` in config). The engine
  makes conservative assumptions and never prompts. Pair with `--watch`, or attach a
  watcher from another terminal.

## Controlling a live run

From any terminal in the repo:

```bash
agent-loop watch          # attach the live dashboard (read-only)
agent-loop pause          # ask the engine to pause at the next checkpoint
agent-loop resume         # resume
agent-loop stop           # cancel the run (kills the active agent process group)
```

In the live dashboard, `p`/`r`/`l`/`g`/`q` map to pause/resume/logs/diff/quit. Quitting
the watcher does **not** stop the run. See
[terminal-dashboard.md](terminal-dashboard.md).

## When a run blocks

A `BLOCKED` run means at least one slice hit a hard violation or exhausted its retries.

1. Read the blocker report: `.agent-loop/reports/blocked-<slice>.md` (objective reason +
   acceptance criteria + the failing details).
2. Inspect the failing check output: `.agent-loop/artifacts/checks/<slice>__<check>.log`.
3. Use `agent-loop inspect` to get the evidence-based explanation of the state.
4. Fix the root cause — adjust the slice's `allowedPaths`, remove a committed secret,
   correct a flaky check, or amend the plan.
5. `agent-loop retry` — clears the block and re-attempts only unfinished work; completed
   slices are never redone. See [recovery.md](recovery.md).

## When a run won't start ("another run appears active")

`run`/`retry` take a single-writer lock at `.agent-loop/control/run.pid`. If a previous
orchestrator was **hard-killed** (`kill -9`, power loss), the lock is detected as stale
(its PID is dead) and reclaimed automatically — just re-run. You only see *"another
agent-loop run appears to be active (pid N)"* when a process with that PID is genuinely
still alive. If you're certain it isn't yours, remove `.agent-loop/control/run.pid` and
retry. (A second `Ctrl-C` on a live run hard-exits and intentionally leaves the lock for
the next run to reclaim.) See [recovery.md](recovery.md).

## UI / browser verification

For frontend slices, enable `browser` in config to start the app, navigate routes, and
capture screenshots + console errors after the deterministic verifier passes:

```yaml
browser:
  enabled: true
  startCommand: "npm run start"
  baseUrl: "http://127.0.0.1:3000"
  routes: ["/", "/dashboard"]
  required: false          # advisory; set true to block a slice on UI failure
```

With Chrome/Chromium installed you get real PNG screenshots + real console-error capture
(CDP); otherwise it falls back to HTTP navigation with HTML snapshots. Artifacts land in
`.agent-loop/artifacts/ui-smoke/`. Browser verification is advisory and can never override
the deterministic verifier. Use `concurrency: 1` when it's enabled (the harness binds a
single `baseUrl`). See [verification.md](verification.md#ui--browser-verification).

## Tuning for throughput vs. caution

| Goal | Knobs |
| --- | --- |
| Faster (independent slices in parallel) | `execution.concurrency: 2+` (slices with non-overlapping scope run in worktrees) |
| More retries before blocking | `execution.maxRetriesPerSlice` |
| Tighter/looser slice size | `verification.maxDiffLines`, `riskPolicy.maxDiffLines` |
| Mandatory human-grade review on risky slices | configure `roles.reviewer` + `riskPolicy.requireReviewAtOrAbove` |
| Cross-model review consensus | `roles.reviewers: [...]` (distinct providers, each votes once) |
| UI/browser verification on frontend slices | `browser.enabled: true` (+ `startCommand`, `baseUrl`, `routes`); `browser.required: true` to block on failure |
| Cap spend | `execution.budgetUsd` / `execution.budgetTokens` (0 = unlimited) |
| Cross-provider fallback | `routing.fallbackOrder`, `routing.switchProviderOnRetry` |

## Inspecting a run

- `agent-loop status [--json]` — verified progress and current state (pure projection).
- `agent-loop watch --once [--json]` — a single dashboard/JSON frame; ideal for CI.
- `agent-loop logs [--follow]` — structured logs.
- `agent-loop diff` — current working-tree diff.
- `agent-loop inspect [<run-id>]` — *why* the run/slice is where it is, from evidence.
- The raw truth: `.agent-loop/events/events.jsonl` (greppable) and `events.db` (SQLite).
- Verified commits: `git log --grep 'agent-loop-slice:'`.

## CI usage

The fake provider makes hermetic CI trivial (no credentials, no network):

```bash
npm ci
npm run build
node dist/bin/agent-loop.js demo        # end-to-end smoke test, exits non-zero on failure
npm test                                 # full suite (all fake-provider based)
```

For real autonomous runs in CI, set provider credentials via the provider's own env
vars, enable `auto: true` (or `--auto`), and gate on `agent-loop status --json`
(`runState == "COMPLETED"` and `verifiedCompleted == totalSlices`). Exit codes from
`run`: `0` COMPLETED, `1` FAILED, `2` BLOCKED, `3` CANCELLED.

## Housekeeping

- `.agent-loop/` is git-ignored locally (via `.git/info/exclude`); the inner
  `.gitignore` keeps `config.yml`, `objective.md`, `plan.json`, `assumptions.md`
  trackable while ignoring transient state. Commit the durable four if you want plan
  provenance in VCS.
- Logs honor `logging.retentionDays`. Worktrees under `.agent-loop/worktrees/` are
  transient and cleaned between runs.
- Run branches use `git.branchPrefix` (default `agent-loop/`). Delete merged ones as you
  would any feature branch.
