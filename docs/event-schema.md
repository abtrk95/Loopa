# Event schema

The event log is the canonical, append-only history of a run. **State is derived from
events**, never the reverse, and the coding agent never writes an authoritative event.
This document specifies the envelope, the taxonomy, and how events drive state.

Source: `src/events/types.ts` (taxonomy + envelope), `src/events/store.ts` (storage),
`src/events/projection.ts` (fold).

## Envelope

Every event validates against `AgentLoopEventSchema`:

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | int ≥ 1 | Currently `1` (`EVENT_SCHEMA_VERSION`). |
| `eventId` | string | Unique id assigned by the store. |
| `seq` | int ≥ 0 | Monotonic sequence number (SQLite `AUTOINCREMENT`). The total order. |
| `ts` | string | ISO-8601 timestamp from the injected clock. |
| `runId` | string | The run this event belongs to. |
| `sliceId` | string \| null | The slice, when applicable. |
| `attemptId` | string \| null | The attempt, when applicable. |
| `correlationId` | string \| null | Optional grouping id. |
| `source` | enum | Producing component (see below). **Never an agent.** |
| `type` | enum | One of `EVENT_TYPES`. |
| `payload` | object | Event-specific data (already redacted at store level). |

Callers append a `NewEvent` (just `runId`, `type`, `source`, and optional
`sliceId`/`attemptId`/`correlationId`/`payload`/`idempotencyKey`); the store assigns
`eventId`, `seq`, and `ts`. The envelope is `.strict()` — unknown fields are rejected.

### Sources

`orchestrator`, `intake`, `planner`, `git`, `process`, `verifier`, `reviewer`,
`browser`, `control`, `github`. There is deliberately **no `agent` source**: an agent's process is
observed (`process` emits `AGENT_PROCESS_*`), but the agent never authors an event that
asserts progress.

## Taxonomy

```
run lifecycle:   RUN_CREATED, INTAKE_STARTED, OBJECTIVE_CREATED, PLAN_CREATED,
                 PLAN_VALIDATED, RUN_STARTED, RUN_PAUSED, RUN_RESUMED,
                 RUN_STOP_REQUESTED, RUN_STATE_CHANGED, ASSUMPTION_RECORDED
slice lifecycle: SLICE_READY, SLICE_STARTED, SLICE_STATE_CHANGED, PROVIDER_SELECTED
agent process:   AGENT_PROCESS_STARTED, AGENT_PROCESS_OUTPUT, AGENT_PROCESS_EXITED
fs / git:        FILE_CHANGED, COMMIT_CREATED, ROLLBACK_STARTED, ROLLBACK_FINISHED
checks/verify:   CHECK_STARTED, CHECK_OUTPUT, CHECK_FINISHED, VERIFICATION_STARTED,
                 VERIFICATION_PASSED, VERIFICATION_FAILED
review:          REVIEW_STARTED, REVIEW_FINISHED
browser:         BROWSER_VERIFICATION_STARTED, BROWSER_VERIFICATION_FINISHED
slice terminal:  SLICE_COMPLETED, SLICE_RETRY_SCHEDULED, SLICE_BLOCKED
final:           FINAL_VERIFICATION_STARTED, FINAL_VERIFICATION_FINISHED,
                 RUN_COMPLETED, RUN_FAILED, RUN_CANCELLED
integrations:    PR_CREATED
```

### Selected payloads

| Type | Key payload fields |
| --- | --- |
| `RUN_CREATED` | `goal` |
| `PLAN_CREATED` | `planId`, `goal`, `branch`, `totalSlices`, `sliceIds`, `sliceTitles` |
| `RUN_STATE_CHANGED` | `from`, `to` |
| `SLICE_STATE_CHANGED` | `from`, `to` |
| `SLICE_READY` | `title` |
| `SLICE_STARTED` | `title`, `attempt` |
| `PROVIDER_SELECTED` | `role`, `provider`, `model` |
| `AGENT_PROCESS_STARTED` | `command`, `role` (`pid` when available) |
| `AGENT_PROCESS_EXITED` | `exitCode`, `costUsd`, `tokens`, `timedOut` |
| `FILE_CHANGED` | `files` (array of real changed paths) |
| `CHECK_STARTED` | `checkId`, `command` |
| `CHECK_FINISHED` | `checkId`, `ok`, `durationMs` |
| `VERIFICATION_PASSED` | `addedLines`, `files` (a **count** of changed files, not the list) |
| `VERIFICATION_FAILED` | `reason` |
| `BROWSER_VERIFICATION_STARTED` | `routes` (count) |
| `BROWSER_VERIFICATION_FINISHED` | `ok`, `ran`, `engine`, `summary`, `routes` (count), `required` |
| `COMMIT_CREATED` | `sha`, `message`, `files` (array of paths; idempotency key `commit:<slice>`) |
| `SLICE_COMPLETED` | `sha`, `summary` |
| `SLICE_RETRY_SCHEDULED` | `attempt`, `reason` |
| `SLICE_BLOCKED` | `reason`, `details` |
| `FINAL_VERIFICATION_FINISHED` | `verdict`, `checks` |
| `PR_CREATED` | `url`, `created` |

## Storage guarantees

- **Append-only.** No update/delete of event rows in normal operation.
- **Monotonic order.** `seq` is a SQLite autoincrement primary key; reads are ordered
  by it. This is the canonical total order used by the projection.
- **Transactional batches.** `appendMany` wraps inserts in a transaction; a failure
  rolls back the whole batch.
- **Idempotent side-effect recording.** If `idempotencyKey` is set and an event with
  that `(runId, key)` already exists, `append` returns the existing event instead of
  inserting a duplicate (enforced by a unique partial index). This makes recording a
  commit safe even if the process crashes between the git commit and the event write.
- **WAL mode.** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000` — a
  separate read-only watcher can tail the log while the engine writes.
- **JSONL mirror.** Every event is also appended to `events/events.jsonl` for easy
  grepping and as a portable export. `exportJsonl()` re-dumps the full log on demand.
- **Redaction at the boundary.** The store is constructed with a `Redactor`; each
  payload is redacted *before* it is persisted, so no secret can land in the durable
  store even if a caller forgot to redact. See [security-model.md](security-model.md).

## Migrations

`store.ts` holds an ordered `MIGRATIONS` array and a `schema_meta(version)` row. On open
it applies any migrations beyond the recorded version, so the schema can evolve without
breaking existing logs. v1 creates the `events` table plus indexes on `(run_id, seq)`,
`(run_id, slice_id, seq)`, and the unique idempotency index.

## Reading the log

The `EventStore` interface offers `read(runId?)`, `readSince(afterSeq, runId?)`,
`recent(limit, runId?)`, `latestSeq(runId?)`, and `runIds()`. The projection consumes a
full (or windowed) read and folds it into a `RunSnapshot`. Because the fold is pure and
deterministic, `status`, `watch`, and `inspect` all reconstruct identical state from the
same bytes — there is no separate, drift-prone "current state" table.
