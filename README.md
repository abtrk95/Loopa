# agent-loop

**A local-first, autonomous coding loop where the AI agent is a worker — not the source of truth.**

agent-loop takes any input (an idea, a PRD in Markdown or JSON, a spec, a README, a
GitHub issue, or stdin), normalizes it into a canonical execution plan, divides the
plan into small verifiable slices, and drives one or more AI coding agents to
implement each slice with **fresh context**. Crucially, an agent saying "done" or
"90% complete" never moves the needle. Progress is computed **only** from objective
evidence: git state, process exit codes, tests, typecheck, lint, build, acceptance
criteria, scope policies, and security scans.

```
Completion = verified completed slices / total slices
```

Everything runs on your machine. The canonical state is an append-only SQLite event
log. The terminal dashboard is a read-only projection of that log. You can run fully
autonomously (`--auto`) or with a human approval gate, pause/resume/stop a run from
any terminal, and recover cleanly from crashes.

---

## Why this exists

LLM coding agents are excellent workers and unreliable narrators. They confidently
report success they didn't achieve, edit files they shouldn't, and lose the plot over
long horizons. agent-loop treats the agent as an untrusted subprocess and wraps it in
a deterministic control system:

- **Objective completion.** A slice is only `COMPLETED` after the deterministic
  verifier passes over the *real* git diff and a scoped commit exists. See
  [docs/verification.md](docs/verification.md).
- **Fresh context per attempt.** Every attempt starts from a clean working tree and a
  freshly-built context pack — no accumulated drift. See [docs/architecture.md](docs/architecture.md).
- **Scoped, attributable commits.** Each slice may only touch its declared paths;
  commits carry an `agent-loop-slice: S-XXX` trailer. See [docs/verification.md](docs/verification.md).
- **Safe recovery.** Crash mid-run? Re-running reconciles from git + the event log and
  re-attempts only unfinished work. See [docs/recovery.md](docs/recovery.md).
- **Secrets never leak.** Redaction is applied at every persistence and display
  boundary. See [docs/security-model.md](docs/security-model.md).

## Quick start (no API keys)

agent-loop ships with a deterministic `fake` provider, so you can see the entire loop
end-to-end without any credentials:

```bash
npm install
npm run build
node dist/bin/agent-loop.js demo      # throwaway repo, runs to COMPLETED, prints the dashboard
```

### Installing the `agent-loop` command

This repo is unpublished, so there is no global `agent-loop` binary by default. Pick one:

```bash
npm link                              # makes `agent-loop` available on your PATH
# …or invoke directly, no link needed:
node dist/bin/agent-loop.js <command>
npm run agent-loop -- <command>       # runs from source via tsx
```

The examples below assume you ran `npm link` (substitute one of the forms above otherwise).

### Driving a real repository

```bash
cd /path/to/your/git/repo
agent-loop init
git add -A && git commit -m "chore: add .agent-loop config"   # init writes config; commit it (runs require a clean tree)
agent-loop plan --idea "Add a /health endpoint that returns 200 and a version string"
agent-loop run --auto
agent-loop status
```

> **Provider note.** The default `fake` provider is deterministic and **demo-only** — it
> makes no edits for an arbitrary `--idea`, so a real plan run with it ends `BLOCKED`
> (by design: it never fakes success). To actually implement a slice, point a role at a
> real agent in `.agent-loop/config.yml` (`claude`, `codex`, or `opencode`) — see
> [docs/provider-adapters.md](docs/provider-adapters.md) and
> [docs/configuration.md](docs/configuration.md). The `demo` command above is the
> end-to-end happy path that needs no credentials.

## Command reference

| Command | What it does |
| --- | --- |
| `init` | Scaffold `.agent-loop/` config + layout, add the local git-ignore entry. |
| `plan --idea/--prd/--spec/--readme/--issue/--stdin` | Normalize input → objective → validated plan of slices. |
| `run [--auto] [--watch]` | Execute (or approve-then-execute) the plan. `--watch` runs the live dashboard. |
| `retry` | Resume a blocked/interrupted run; re-attempt unfinished slices only. |
| `watch [--json/--plain/--once]` | Attach the read-only live dashboard from any terminal. |
| `status [--json]` | Print run status derived from verified state. |
| `pause` / `resume` / `stop` | Express control intent to a running engine (via the control plane). |
| `logs [--follow]` | Show structured logs. |
| `diff` | Show the current working-tree diff. |
| `doctor` | Check environment + provider health. |
| `providers` | List configured providers, detected versions, health. |
| `inspect [<run-id>]` | Explain *why* a run/slice is in its current state, from evidence. |
| `pr create [--push]` | Open a **draft** PR via `gh`. Never auto-merges or deploys. |
| `demo` | Deterministic end-to-end demo in a throwaway repo. No API keys. |

Full flags: `agent-loop --help`. Operational playbook: [docs/operations.md](docs/operations.md).

## How it works (one paragraph)

`intake` sniffs and normalizes your input into a validated `Objective` + user stories.
`planner` turns those into a `Plan` of slices, each with `allowedPaths`, acceptance
criteria, required checks, a risk level, and a dependency DAG. The `RunEngine` selects
eligible slices (respecting the DAG), and for each slice the `executor` runs the
worker agent against a fresh context pack, reads the **real** diff, and hands it to the
deterministic `verifier`. A `pass` (optionally plus an advisory model review) produces
a scoped commit and marks the slice `COMPLETED`; a `fail` triggers a bounded fixer
retry; a `block` stops the slice with a written blocker report. When every slice is
committed, a global `FINAL_VERIFYING` pass runs the project's checks against the
integrated result. Independent slices can run in parallel in isolated git worktrees.
Every step appends events to the SQLite log; the dashboard and `status` are pure
projections of it.

## Status & known limitations

agent-loop is a **release candidate** (`0.2.0-rc`). It is **not** marketed as
"production-ready" in the unqualified sense — but the deterministic core and the
operational/safety hardening below are implemented, tested, and honestly bounded.

**Implemented and tested** (`npm run check`):

- Evidence-based completion, the append-only SQLite event log, scoped/verified commits
  (incl. agent-self-commit and resume-bypass protection), safe parallel worktrees, the
  read-only dashboard, shell-free process execution, and the deterministic safety scanner.
- **Provider fallback**, **switch-on-retry**, and **reviewer consensus** — including a
  panel of **distinct** reviewer providers/models (`roles.reviewers`) for cross-model
  consensus. A reviewer can never override the deterministic verifier.
- **Browser/UI verification** (`browser.*`, off by default): starts the app, navigates
  routes, captures screenshots + console errors, and cleans up. Real Chrome via the
  DevTools Protocol when available (real PNG screenshots + console capture), with a
  zero-dependency HTTP fallback. Advisory unless `browser.required: true`; it runs only
  after a verifier pass, so it can never override it. See
  [docs/verification.md](docs/verification.md).
- **Process cleanup hardening**: single-writer run lock with stale-PID (`kill -9`)
  recovery, process-group/tree reaping (POSIX groups; Windows `taskkill /T` best-effort),
  and SIGINT/SIGTERM/timeout coverage. See [docs/recovery.md](docs/recovery.md).
- **Artifact privacy**: the `.agent-loop/` tree is created owner-only (`0700` dirs /
  `0600` sensitive files) where the OS enforces POSIX modes, and secrets are redacted
  before they reach logs, events, reports, context packs, and the dashboard. Tests assert
  no secret persists in SQLite, JSON, logs, reports, or TUI snapshots.
- **Real-provider smoke harness** (`test/integration/provider-smoke.test.ts`): hermetic
  argv stubs prove command/model construction for claude/codex/opencode; opt-in env-gated
  tests probe the real CLIs. See [docs/provider-adapters.md](docs/provider-adapters.md).
- **GitHub live-safe validation**: hermetic `gh`-stub tests prove draft-by-default, push
  only with `--push`, dedupe, and **no auto-merge/auto-deploy path**; an optional live
  test runs against a throwaway repo. See [docs/github-integration.md](docs/github-integration.md).

**Known limitations (honest):**

- **`judge` role** — accepted in config but **reserved/not wired** (never invoked). So is
  `roles.browser` (a future provider-driven browser role); the *wired* browser feature is
  the top-level `browser` config section.
- **Platform support is macOS/Linux.** Windows is **untested and unsupported** (shell-free
  spawn cannot launch `.cmd`/`.bat` shims; `taskkill`-based tree reaping is implemented
  but unexercised in CI). CI gates on Linux + macOS; a Windows job runs non-blocking.
- **Real multi-provider runs are proven hermetically, not at scale.** Live paid
  `claude`/`codex`/`opencode` runs are opt-in and not in CI.
- **Browser verification with `concurrency > 1`** assumes per-slice ports (the harness
  binds one `baseUrl`); use `concurrency: 1` when enabling it.
- **Threat model.** agent-loop verifies what *it* commits and rejects agent self-commits
  and unverified trailer commits on resume. A human with direct write access to the
  repository/git history is outside the threat model.
- **Packaging.** `private: true`, no LICENSE yet — not published to npm.

Release process and gates: [docs/release-checklist.md](docs/release-checklist.md). A full
evidence-based assessment is in
[docs/production-readiness-audit.md](docs/production-readiness-audit.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, data flow, the 16 building blocks.
- [docs/verification.md](docs/verification.md) — the deterministic verifier (the heart of the system).
- [docs/state-machine.md](docs/state-machine.md) — run and slice state machines.
- [docs/event-schema.md](docs/event-schema.md) — the event taxonomy and envelope.
- [docs/provider-adapters.md](docs/provider-adapters.md) — provider contract, presets, adding one.
- [docs/configuration.md](docs/configuration.md) — every config key, precedence, env, CLI overrides.
- [docs/security-model.md](docs/security-model.md) — threat model, redaction, scope, opt-in danger flags.
- [docs/recovery.md](docs/recovery.md) — crash recovery, resume, retry, blockers.
- [docs/terminal-dashboard.md](docs/terminal-dashboard.md) — the watcher, layout, keys, modes.
- [docs/github-integration.md](docs/github-integration.md) — PR creation, what we never do.
- [docs/operations.md](docs/operations.md) — day-to-day operating playbook.
- [docs/troubleshooting.md](docs/troubleshooting.md) — common failures and fixes.
- [docs/reference-analysis.md](docs/reference-analysis.md) — what we learned from prior art.
- [docs/release-checklist.md](docs/release-checklist.md) — release gates + the RC sign-off.
- [docs/adr/0001-implementation-stack.md](docs/adr/0001-implementation-stack.md) — stack decisions.

## Requirements

- **Node ≥ 22.5** (uses the built-in `node:sqlite`; no native build step).
- **git** on `PATH`.
- A git repository to operate on.
- For real providers: the corresponding CLI (`claude`, `codex`, `opencode`) installed
  and authenticated. For `pr create`: `gh` installed and authenticated.

## Project layout

```
src/
  domain/        schemas (zod), state machines, errors, ids
  events/        event taxonomy, SQLite store, pure projection
  intake/        input detection + normalization
  planner/       plan building, DAG analysis, validation
  config/        config schema + layered loader
  process/       sandboxed process manager, command tokenizer
  git/           repo ops, scope policy, worktree pool
  providers/     adapter contract, fake + command providers, registry, router
  verify/        deterministic verifier + safety checks
  review/        advisory model reviewer
  orchestrator/  run engine, slice executor, session, planning, control, retry, report
  watch/         dashboard renderer + watcher
  github/        PR creation
  security/      redaction + env secret collection
  util/          paths, fs, logger, clock, ids
test/            unit, integration, e2e (all use the fake provider — no paid calls)
docs/            this documentation set
```

## Licensing

This repository intentionally ships **without a license file** — all rights are
reserved by the author pending an explicit licensing decision. It is a clean-room
implementation; no third-party source was copied. Conceptual influences are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
