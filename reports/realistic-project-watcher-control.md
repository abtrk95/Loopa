# Phase 11 — Watcher & Control-Flow Validation

**Date:** 2026-06-22 · Repo: `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042`

## Result: PASS

## Live observation (during real runs — non-destructive)
| Capability | Evidence (live) |
| --- | --- |
| `watch --once` attaches to a RUNNING issue run | Phase 7: while `run-issue` ran, `watch --once` showed `RUNNING … S-001 phase=working provider=claude`, progress `0/1` |
| Watcher detaches without stopping the run | After each `watch --once`/`status` snapshot, the background run continued to COMPLETED — observation never interrupted it |
| Watcher reconnects (consistent) | Repeated `watch --once`/`status` during a run returned consistent, monotonically-advancing snapshots; hermetic `watch-secrets` → "renders a JSON snapshot once, and re-attaching is consistent" |
| `watch --once --json` | Valid `{snapshot, git}`; `snapshot.runState`, `verifiedCompleted/totalSlices`, per-slice `provider` (S-001 claude, S-002 codex) |
| `watch --once --plain` | Concise text frame: `agent-loop watch — COMPLETED … progress: 2/2 (100%) … checks: typecheck:passed lint:passed test:passed build:passed` |
| `watch --once --no-color` | **0 ANSI escape sequences** in output |
| `--plain --no-color` combined | Works |
| `status` / `status --json` | Live `RUNNING 0/1` → `COMPLETED 1/1`; JSON parsed cleanly |
| `inspect` | Explained state from evidence ("verified-completed/total = 1/1"; blocker reason on BLOCKED runs) |
| `logs` | Structured event stream incl. `VERIFICATION_PASSED`, `COMMIT_CREATED`, `PR_CREATED` |
| `diff` | Streamed the agent's in-progress edits live; on a clean tree prints "(no uncommitted changes)" |
| **Progress = verified-completed / total** | Confirmed across runs: `0/1→1/1`, `0/2→1/2→2/2` (`progressFraction` 1.0 at done) |

## Control commands (CLI interface — live)
| Command | Output | exit |
| --- | --- | --- |
| `pause` | "Pause requested. The running engine will pause at the next checkpoint." | 0 |
| `resume` | "Resume requested." | 0 |
| `stop` | "Stop requested. In-flight processes will be terminated." | 0 |
| `retry` (on COMPLETED run) | idempotent no-op → "run COMPLETED" | 0 |

(Stale control intent issued during this test was cleared; a fresh run clears stale intent automatically — `e2e-hardening` → "a cleared control plane lets a previously-stopped run complete".)

## Destructive control semantics (hermetic — controlled fixtures, baseline-passing)
| Behavior | Test |
| --- | --- |
| Pause prevents new work / resume continues | `recovery-control` → "control plane > pauses and resumes through the control plane" |
| Stop does not corrupt state | `recovery-control` → "control plane > stop before start cancels the run and terminates without committing" |
| Resume re-attempts only unfinished work | `recovery-control` → "crash recovery + resume > resumes a blocked run and re-attempts the blocked slice **without redoing completed work**" |
| Retry only retries valid failed/blocked work | live idempotent no-op on COMPLETED + the above resume test (completed slices untouched) |
| Resuming a completed run is idempotent | `recovery-control` → "resuming an already-completed run is an idempotent no-op" |
| Stop leaves GitHub state consistent | Phase 8a/8b BLOCKED runs left issue OPEN + label `blocked` + no PR (no corruption) |

Test run this session: `recovery-control.test.ts` (4) + `watch-secrets.test.ts` (4) → **8 passed**.

**Phase 11 verdict: PASS.** The read-only dashboard attaches/detaches/reconnects to live runs without affecting them, all output modes (json/plain/no-color) render correctly, progress is the verified ratio, and pause/resume/stop/retry behave safely (live interface + hermetic semantics).
