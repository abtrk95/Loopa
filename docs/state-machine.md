# State machines

agent-loop has two explicit, validated state machines: one for the **run** and one for
each **slice**. They are defined in `src/domain/states.ts`. Every transition is checked
by `assertRunTransition` / `assertSliceTransition`, which throw
`InvalidStateTransitionError` on an illegal edge. The orchestrator is the *only*
component allowed to mutate state, and it must route every change through these asserts.

State is also *derived* from the event log by the projection (`src/events/projection.ts`).
The transition tables and the projection are kept in agreement deliberately: the live
engine and any reader reconstruct the same state from the same events.

## Authoritative drivers

Two event types drive the machines:

- `RUN_STATE_CHANGED` — payload `{ from, to }`, authoritative for the run state.
- `SLICE_STATE_CHANGED` — payload `{ from, to }`, authoritative for a slice's state.

Other "semantic" events (`RUN_STARTED`, `SLICE_COMPLETED`, `COMMIT_CREATED`, …) carry
audit detail and dashboard data. Some semantic events also imply a state for the
projection (e.g. `RUN_COMPLETED` ⇒ `COMPLETED`), but the engine emits them together with
the corresponding state change so the log is internally consistent.

## Run states

```
CREATED ─► INTAKE ─► PLANNING ─► PLAN_READY ─► RUNNING ─┬─► FINAL_VERIFYING ─► COMPLETED
                                                        │                  └─► FAILED
                                                        ├─► PAUSED ─► RUNNING
                                                        ├─► BLOCKED ─► (RUNNING | PAUSED)
                                                        ├─► FAILED
                                                        └─► CANCELLED
```

| State | Meaning |
| --- | --- |
| `CREATED` | Run record exists; nothing planned yet. |
| `INTAKE` | Normalizing input into an objective. |
| `PLANNING` | Building and validating the plan. |
| `PLAN_READY` | Plan validated and persisted; awaiting execution (or approval). |
| `RUNNING` | The main loop is executing slices. |
| `PAUSED` | Control plane requested pause; loop is idling at a checkpoint. |
| `BLOCKED` | One or more slices are blocked; resumable after human action. |
| `FINAL_VERIFYING` | All slices committed; running global checks on the integrated result. |
| `COMPLETED` | Terminal. All slices verified-complete and final verification passed. |
| `FAILED` | Terminal. A slice failed, or final verification failed. |
| `CANCELLED` | Terminal. A stop was requested. |

Transition table (from `RUN_TRANSITIONS`):

```
CREATED          → INTAKE, CANCELLED, FAILED
INTAKE           → PLANNING, BLOCKED, CANCELLED, FAILED
PLANNING         → PLAN_READY, BLOCKED, CANCELLED, FAILED
PLAN_READY       → RUNNING, CANCELLED, FAILED
RUNNING          → PAUSED, BLOCKED, FINAL_VERIFYING, CANCELLED, FAILED
PAUSED           → RUNNING, CANCELLED, FAILED
BLOCKED          → RUNNING, PAUSED, CANCELLED, FAILED
FINAL_VERIFYING  → COMPLETED, RUNNING, BLOCKED, FAILED, CANCELLED
COMPLETED        → (terminal)
FAILED           → (terminal)
CANCELLED        → (terminal)
```

Terminal run states: `COMPLETED`, `FAILED`, `CANCELLED` (`TERMINAL_RUN_STATES`).

### Terminal-state nuances (resume/retry)

- `resume()` on a `COMPLETED` run is a no-op (idempotent) — it returns the completed
  result without attempting an illegal transition.
- `retry` on a `FAILED`/`CANCELLED` run re-opens it by emitting `RUN_RESUMED` and
  setting the in-memory state back to `RUNNING` directly (bypassing the terminal assert,
  because the durable log already holds the terminal event). This is the one
  intentional exception, isolated in `reenterRunning()`.
- `finish()` guards against double-transitioning a run that a stop request already drove
  to a terminal state (`isTerminalRunState` check).

## Slice states

```
PENDING ─► READY ─► PREPARING ─► EXECUTING ─► VERIFYING ─┬─► COMMITTING ─► COMPLETED
                        │             │           │       └─► REVIEWING ─► COMMITTING
                        │             │           │                    └─► FIXING ─► VERIFYING
                        │             │           └─► RETRY_PENDING ─► READY
                        │             └─► RETRY_PENDING / BLOCKED / FAILED
                        └─► BLOCKED ─► READY (on retry)
```

| State | Meaning |
| --- | --- |
| `PENDING` | In the plan, not yet eligible/selected. |
| `READY` | Eligible (deps complete) and selected for an attempt. |
| `PREPARING` | Clean tree established; context pack being built. |
| `EXECUTING` | The worker (or fixer) agent process is running. |
| `VERIFYING` | Deterministic verification over the real diff. |
| `REVIEWING` | Advisory model review (only if configured & risk threshold met). |
| `FIXING` | A fixer pass addressing review feedback. |
| `COMMITTING` | Creating the scoped commit. |
| `COMPLETED` | Terminal. Verified and committed. **Counts toward progress.** |
| `RETRY_PENDING` | A recoverable failure; backoff before the next attempt. |
| `BLOCKED` | Stopped on a hard violation or exhausted retries; resumable after action. |
| `FAILED` | Terminal failure (e.g. parallel integration conflict). |
| `CANCELLED` | Terminal; run was stopped. |

Transition table (from `SLICE_TRANSITIONS`):

```
PENDING        → READY, CANCELLED, BLOCKED
READY          → PREPARING, CANCELLED, BLOCKED
PREPARING      → EXECUTING, FAILED, CANCELLED, BLOCKED
EXECUTING      → VERIFYING, RETRY_PENDING, BLOCKED, FAILED, CANCELLED
VERIFYING      → REVIEWING, COMMITTING, RETRY_PENDING, BLOCKED, FAILED, CANCELLED
REVIEWING      → COMMITTING, FIXING, RETRY_PENDING, BLOCKED, FAILED, CANCELLED
FIXING         → VERIFYING, RETRY_PENDING, BLOCKED, FAILED, CANCELLED
COMMITTING     → COMPLETED, FAILED, CANCELLED
RETRY_PENDING  → READY, PREPARING, BLOCKED, FAILED, CANCELLED
COMPLETED      → (terminal)
BLOCKED        → READY, CANCELLED, FAILED
FAILED         → (terminal)
CANCELLED      → (terminal)
```

Terminal slice states: `COMPLETED`, `FAILED`, `CANCELLED` (`TERMINAL_SLICE_STATES`).
Note `BLOCKED` is **not** terminal — it can return to `READY` on resume/retry, which is
how a human-fixed blocker gets re-attempted.

## Why a slice only "counts" at COMPLETED

The projection computes `verifiedCompleted` by counting slices in `COMPLETED`. A slice
reaches `COMMITTING → COMPLETED` only after:

1. the agent produced a non-empty diff, and
2. the deterministic verifier returned `pass`, and
3. (if required) the reviewer did not block/request-changes, and
4. a scoped commit was successfully created.

There is no path to `COMPLETED` that skips verification + commit. That is the structural
guarantee behind `Completion = verifiedCompleted / totalSlices`.

## Mapping states to the dashboard "phase"

The projection maps each slice state to a short phase label (`PHASE_LABEL`) shown in the
dashboard's CURRENT SLICE box: `working` (EXECUTING), `verifying`, `reviewing`,
`fixing`, `committing`, `retry pending`, `blocked`, etc. See
[terminal-dashboard.md](terminal-dashboard.md).
