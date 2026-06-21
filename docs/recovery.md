# Recovery, resume, and retry

A long autonomous run will be interrupted — a crash, a `Ctrl-C`, a laptop sleep, a
blocked slice that needs a human. agent-loop is built so that interruption is safe and
resumption is cheap, because **state is reconstructed from durable evidence** (the event
log + git), never held only in memory.

Source: `src/orchestrator/run.ts` (`seedFromHistory`, `reconcile`, `resume`,
`clearBlockedForRetry`), `src/orchestrator/executor.ts` (clean-tree invariant, idempotent
commit), `src/orchestrator/control.ts`.

## The invariants that make recovery work

1. **Append-only log is canonical.** Every meaningful step is an event with a monotonic
   `seq`. Re-reading the log reproduces exact run/slice state via the pure projection.
2. **Clean tree before every attempt.** The executor calls `rollback()` at the start of
   each attempt, so there is never ambiguous half-work to interpret.
3. **Idempotent commit recording.** `COMMIT_CREATED` carries `idempotencyKey:
   commit:<slice>`, and the commit itself is found-or-created (`findSliceCommit`). A
   crash *between* the git commit and the event write cannot produce a double commit or
   a lost slice.
4. **Slice commits are self-identifying.** The `agent-loop-slice: S-XXX` trailer lets
   reconciliation discover, on resume, that a slice was actually committed even if its
   completion event never made it to disk.

## What happens on `resume` / `retry`

`agent-loop retry` (or an internal resume) runs this sequence:

1. **`seedFromHistory()`** — fold the run's events into a snapshot and rebuild the
   in-memory sets (`completed`, `blocked`, `failed`) and dependency results. The engine
   now knows exactly where it left off.
2. **`ensureOnBranch()`** — check out the run branch (it must still exist).
3. **Completed-run short-circuit** — if the run is already `COMPLETED`, return that
   result unchanged (idempotent no-op; no illegal transition).
4. **`reconcile()`** — for every slice not already known done/blocked/failed, look for
   its commit by trailer. If found, synthesize the `COMMIT_CREATED` +
   `SLICE_STATE_CHANGED(→COMPLETED)` + `SLICE_COMPLETED` events ("recovered on resume")
   and mark it complete. Then `rollback()` discards any uncommitted leftovers from the
   interrupted attempt.
5. **`clearBlockedForRetry()`** — blocked slices transition `BLOCKED → READY` so they
   get a fresh attempt (this is how a human-fixed blocker re-enters the loop).
6. **`reenterRunning()`** — re-open the run. From a non-terminal state this is a normal
   `RUN_RESUMED`; from a terminal `FAILED`/`CANCELLED` it re-opens by emitting
   `RUN_RESUMED` and setting state directly (the durable log already holds the terminal
   event, so the terminal assert is intentionally bypassed here only).
7. **`mainLoop()`** resumes, re-attempting only unfinished work.

Net effect: **completed slices are never redone**, and the run continues from the first
unfinished slice.

## Retry within a slice (the fixer loop)

Inside a single slice attempt, recoverable failures trigger a bounded retry rather than a
resume:

- A `fail` verdict, a process crash/timeout, or a reviewer "changes requested" →
  `SLICE_RETRY_SCHEDULED`, a deterministic backoff
  (`base * 2^(attempt-1)` + bounded jitter), then another attempt with the **fixer**
  provider and a context pack that includes the previous failure's reason and details.
- The number of attempts is `1 + maxRetriesPerSlice` (default 3: one worker + two
  fixer).
- When retries are exhausted, the slice is **blocked** (not silently dropped) with a
  written blocker report.

## Blocked runs need a human, then `retry`

A `block` verdict (secret, `.git` write, traversal, forbidden path) is *not*
auto-retried — retrying the same prompt would reproduce the violation. The slice is
blocked, a `blocked-<slice>.md` report explains the objective reason, and the run ends in
`BLOCKED`. The operator fixes the underlying issue (adjusts scope, removes the blocker,
amends the plan) and runs `agent-loop retry`, which clears the block and re-attempts.

## Cascade blocking (don't chase impossible work)

When a slice is blocked or failed, any slice that depends on it can never become eligible.
`cascadeBlockUnreachable()` marks those downstream slices `BLOCKED` with reason
"unreachable: dependency blocked/failed", so the run reaches a clean terminal state
instead of spinning. After you unblock the root cause, `retry` re-opens the whole chain.

## Parallel-run recovery

In parallel mode each slice runs in its own worktree; verified commits are cherry-picked
onto the run branch sequentially. If a process dies mid-batch:

- Worktrees are transient (`.agent-loop/worktrees/`) and are released/cleaned on the next
  run; partially-built worktree state is discarded.
- A slice whose commit landed on the run branch is recovered by `reconcile()` via its
  trailer exactly like the sequential case.
- A cherry-pick conflict during integration downgrades that slice to `failed` with reason
  "merge conflict during parallel integration" — recorded, visible, and retryable after
  you resolve the overlap (or after the conflicting sibling completes).

## Control-plane interruptions (pause/stop)

`pause`/`resume`/`stop` write desired state to `.agent-loop/control/control.json`; the
engine reads it at checkpoints and via a poller:

- **pause** → run enters `PAUSED`, idling at the checkpoint until `resume` (or `stop`).
- **stop** → the engine aborts the active process group (`pm.killAll()` via the abort
  signal) and transitions to `CANCELLED`. A subsequent `retry` resumes from the durable
  log as above.

Because the watcher only ever *expresses intent* in this file and never edits run state,
attaching/detaching a dashboard — even mid-run, even repeatedly — is always safe.

## Tests

`test/integration/recovery-control.test.ts` proves: a blocked run resumes and
re-attempts the blocked slice without redoing completed work; resuming an already
completed run is an idempotent no-op; and pause/resume round-trips through the control
plane.
