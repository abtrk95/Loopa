# Architecture

agent-loop is an **event-sourced control system** that supervises untrusted AI coding
agents. This document explains the components, how data flows between them, and how the
16 required building blocks map onto the source tree.

## First principle

> The AI agent is a worker, not the source of truth.

Every design decision follows from this. Agents run as subprocesses whose textual
claims are advisory at most. Authoritative state lives in an append-only event log and
is *derived* from objective evidence (git, exit codes, checks). The same pure
projection function computes that state for the engine, the `status` command, and the
live dashboard — so they can never disagree.

## The 16 building blocks → source map

| # | Building block | Where it lives |
| --- | --- | --- |
| 1 | Input intake & normalization | `src/intake/{detect,normalize}.ts` |
| 2 | Objective & plan model (schemas) | `src/domain/schemas.ts` |
| 3 | Planner (stories → slices, DAG) | `src/planner/{plan,graph,validate}.ts` |
| 4 | Canonical event store (SQLite WAL) | `src/events/store.ts` |
| 5 | Pure projection (events → snapshot) | `src/events/projection.ts` |
| 6 | Run & slice state machines | `src/domain/states.ts` |
| 7 | Run engine (main loop) | `src/orchestrator/run.ts` |
| 8 | Slice executor (per-slice lifecycle) | `src/orchestrator/executor.ts` |
| 9 | Deterministic verifier | `src/verify/{verifier,checks}.ts` |
| 10 | Scope & structural safety | `src/git/scope.ts` |
| 11 | Git isolation (commits, worktrees) | `src/git/{repo,worktree}.ts` |
| 12 | Provider adapters & routing | `src/providers/*` |
| 13 | Process sandbox | `src/process/{manager,command}.ts` |
| 14 | Control plane (pause/resume/stop) | `src/orchestrator/control.ts` |
| 15 | Terminal dashboard (read-only) | `src/watch/{render,dashboard}.ts` |
| 16 | Secret redaction | `src/security/{redact,env}.ts` |

Supporting: config (`src/config/*`), advisory review (`src/review/*`), GitHub
(`src/github/*`), CLI (`src/cli/*`), session assembly (`src/orchestrator/session.ts`),
reporting (`src/orchestrator/report.ts`).

## Data flow

```
                 ┌──────────┐   normalize   ┌───────────┐   build    ┌──────────┐
  any input ───► │  intake  │ ────────────► │ objective │ ─────────► │   plan   │
  (idea/PRD/      └──────────┘                └───────────┘  validate  └────┬─────┘
   issue/stdin)                                                             │ slices + DAG
                                                                            ▼
                    ┌───────────────────────────── RunEngine (run.ts) ─────────────────┐
                    │  select eligible slices (topo order, respects deps)              │
                    │  for each batch:                                                  │
                    │    executeSlice (executor.ts):                                    │
                    │      clean tree ─► build fresh context pack ─► run worker agent   │
                    │        ─► read REAL diff ─► deterministic verify ─► [review]      │
                    │        ─► pass: scoped commit + COMPLETED                         │
                    │        ─► fail: bounded fixer retry                               │
                    │        ─► block: blocker report, stop slice                       │
                    │  when all committed ─► FINAL_VERIFYING (global checks)            │
                    └───────────────────────────────┬──────────────────────────────────┘
                                                     │ append events
                                                     ▼
                              ┌──────────────────────────────────────┐
                              │  SQLite event log  (events.db, WAL)   │  ◄── canonical state
                              │  + JSONL mirror (events.jsonl)        │
                              └───────────────┬──────────────────────┘
                                              │ project(events)
                          ┌───────────────────┼────────────────────┐
                          ▼                   ▼                    ▼
                     status cmd          watch dashboard       inspect cmd
                    (read-only)          (read-only)          (read-only)
```

The dashed boundary matters: **only the engine writes authoritative state**, and it
writes it as events. Every reader (status, watch, inspect) is a pure function of the
log. The control plane (pause/resume/stop) is the one channel by which a reader can
*request* a change — but it only writes intent to a file; the engine acts on it.

## Component detail

### Intake (`src/intake`)
`detectStack` inspects the repo (e.g. `package.json` scripts, `go.mod`, `Cargo.toml`,
Python markers) to propose default verification checks. `normalizeInput` accepts a
`RawInput` whose `kind` is one of `idea | prd-md | prd-json | spec | readme | issue |
stdin`. For `stdin` it sniffs the actual format (JSON vs Markdown vs bare idea) and
records the *sniffed* kind in `objective.source.kind` for provenance. The output is a
validated `Objective` plus zero or more user stories. Assumptions made during
normalization are recorded (never silently invented).

### Domain (`src/domain`)
zod schemas are the single source of truth: runtime validation **and** inferred
TypeScript types come from the same definitions. `schemas.ts` defines `Objective`,
`Plan`, `Slice`, `CheckSpec`, `RiskPolicy`, `ReviewVerdict`, etc. Slice ids match
`/^S-\d{3,}$/`; every slice must declare at least one `allowedPaths` glob and at least
one acceptance criterion. `states.ts` holds the two state machines (see
[state-machine.md](state-machine.md)). `errors.ts` defines a typed error hierarchy with
stable categories for clean CLI reporting.

### Events (`src/events`)
The store is append-only, backed by Node's built-in `node:sqlite` in WAL mode (no
native compilation). Sequence numbers are monotonic; writes are transactional; an
optional `idempotencyKey` makes recording side effects (like a commit) safe across
crashes and retries. `projection.ts` is a *pure* fold: `project(events) → RunSnapshot`.
Progress is `verifiedCompleted / totalSlices`, where `verifiedCompleted` counts slices
in the `COMPLETED` state — which the engine only enters after verification passed and a
commit exists. See [event-schema.md](event-schema.md).

### Planner (`src/planner`)
`buildPlan` turns normalized stories into slices, remapping human story ids to
canonical `S-NNN` ids and rewriting dependency references. If the input is a single
vague idea, it produces one conservative slice rather than fabricating structure.
`graph.ts` provides DAG primitives: cycle detection, topological ordering, eligibility
(a slice is eligible when all its dependencies are complete and it isn't busy),
scope-overlap detection, and parallel-safety checks. `validate.ts` rejects plans with
cycles, dangling dependencies, empty scopes, or id collisions *before* any execution.

### Orchestrator (`src/orchestrator`)
- `session.ts` assembles the shared dependencies (paths, config, store with redactor,
  provider registry, git, process manager, logger, clock) so the CLI and the engine
  build them identically. It also ensures `.agent-loop/` is git-ignored locally.
- `run.ts` is the run-level state machine + main loop: preflight (clean-tree check,
  branch creation), slice selection, sequential or parallel execution, commit
  integration, control handling, final verification, and computing the terminal state.
- `executor.ts` is the single-slice lifecycle where the core principle is enforced
  (clean tree → agent → real diff → verify → review → commit).
- `planning.ts` runs intake→plan→validate→persist and emits the creation events.
- `control.ts` is the file-based control plane. `retry.ts` is deterministic bounded
  backoff. `report.ts` renders the human run report. `context.ts` builds the fresh
  per-attempt context pack.

### Process sandbox (`src/process`)
`ProcessManager.run` spawns with `shell: false` (no shell injection), in a detached
process group so a timeout can `SIGTERM`→`SIGKILL` the *whole* group rather than
orphaning children. Output is captured into a bounded buffer, redacted, and streamed.
The environment is filtered. Cancellation is wired through an `AbortSignal`. This is
the only place the system shells out, so every external call inherits these protections.

### Git (`src/git`)
`GitRepo` wraps git plumbing bound to a directory: status with `--untracked-files=all`,
real diffs *including untracked files* (`diffWithUntracked`, so safety scans see new
files too), scoped commits with the slice trailer, rollback that preserves
`.agent-loop/`, slice-commit lookup, and worktree add/remove + cherry-pick integration.
`scope.ts` evaluates path policy and runs the structural scan. `worktree.ts` is the
pool used for safe parallel execution.

### Providers (`src/providers`)
A provider is a worker behind the `ProviderAdapter` interface. `FakeProvider` is
deterministic and reads `.agent-loop/fake-provider.json` (used by tests and `demo`).
`CommandProvider` is a generic CLI adapter with presets for `claude`/`codex`/`opencode`.
`Router` implements role routing (static/round-robin/weighted/capability + fallback).
The orchestration core never imports a concrete provider. See
[provider-adapters.md](provider-adapters.md).

### Verify & review (`src/verify`, `src/review`)
The verifier is model-independent and authoritative. The reviewer is an *advisory*
model pass that can request changes or flag concerns but can **never** override a
verifier verdict. See [verification.md](verification.md).

### Watch (`src/watch`)
`render.ts` draws the boxed terminal dashboard (responsive 3-column/2-column layout)
from a `RunSnapshot`. `dashboard.ts` is the reconnectable watcher with `json`, `plain`,
`once`, and `live` modes and keyboard control. It is strictly read-only with respect to
state. See [terminal-dashboard.md](terminal-dashboard.md).

## On-disk layout

Everything is under `.agent-loop/` in the target repo (see `src/util/paths.ts`):

```
.agent-loop/
  config.yml            # tracked-by-default: your configuration
  objective.md          # tracked-by-default: human-readable objective
  plan.json             # tracked-by-default: the validated plan (provenance)
  assumptions.md        # tracked-by-default: recorded assumptions
  state/run.json        # run metadata (branch, baseline sha)
  events/events.db      # canonical event log (SQLite WAL)
  events/events.jsonl   # human-greppable mirror
  artifacts/
    logs/               # structured logs
    context/            # the exact context pack sent each attempt
    checks/             # captured check stdout/stderr per slice
    reviews/            # reviewer outputs
    ui-smoke/           # browser/UI verification artifacts (PNG screenshots via CDP, HTML snapshots, browser.json)
  worktrees/            # transient per-slice worktrees (parallel mode)
  reports/              # run report + per-slice blocker reports
  control/control.json  # control-plane desired state
```

An inner `.agent-loop/.gitignore` keeps the durable, meaningful artifacts (config,
objective, plan, assumptions) trackable while ignoring transient/large/sensitive state.
Separately, the session adds `.agent-loop/` to `.git/info/exclude` so run metadata
never dirties your tree or gets wiped by rollback's `git clean`.

## Concurrency model

Within one run, independent slices (no dependency relationship and non-overlapping
`allowedPaths`) can execute concurrently up to `execution.concurrency`. Each parallel
slice runs in its own git worktree branched from the current run-branch head; verified
commits are integrated back onto the run branch sequentially via cherry-pick. A
cherry-pick conflict downgrades that slice to `failed` (recorded, never silently
dropped). Slices with overlapping scope are serialized automatically by the batch
selector. See [recovery.md](recovery.md) for how interrupted parallel work is
reconciled.
