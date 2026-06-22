# Smoke Gate — before GitHub triage + interview work

**Date:** 2026-06-22
**Baseline branch:** `live-real-provider-smoke`
**New work branch:** `github-triage-and-interview` (cut from the baseline after this gate passed)
**Node:** v22.22.1  **npm:** 10.9.4

## Purpose

Prove the current product is green before adding the interview/intake wizard and
GitHub triage/Kanban automation. If this gate had failed, only the blocking issue
would be fixed; no new features would be started.

## Commands and results

| Step | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | ✅ 188 packages, 3 low-severity (dev-only) advisories |
| Check | `npm run check` (typecheck + lint + test) | ✅ 27 files, **162 passed / 5 skipped** |
| Build | `npm run build` | ✅ clean `tsc` build, bin chmod 755 |
| Demo | `node dist/bin/agent-loop.js demo` | ✅ COMPLETED, **3/3 slices verified** |
| Audit | `npm audit --omit=dev` | ✅ **found 0 vulnerabilities** |
| Pack | `npm pack --dry-run` | ✅ 265 files, 329.1 kB tarball |

### Disposable fake-provider E2E (`/tmp/agent-loop-smoke-gate`)

| Step | Command | Result |
| --- | --- | --- |
| init | `agent-loop init` | ✅ wrote `.agent-loop/config.yml` |
| plan | `agent-loop plan --idea "Add a small health check utility with tests"` | ✅ 1 slice (S-001, low risk, checks: test) |
| run (dirty tree) | `agent-loop run --auto` | ✅ **correctly refused** — "working tree has 2 uncommitted change(s)" safety guard |
| run (clean tree) | `agent-loop run --auto` | ✅ ran, then **BLOCKED** (expected — see below) |
| status | `agent-loop status` | ✅ `BLOCKED`, Progress `0/1 (0%)`, objective blocker shown |
| inspect | `agent-loop inspect` | ✅ event timeline + `Progress is verified-completed/total = 0/1` |

## On the `BLOCKED` result (expected, not a failure)

The `run --auto` ended `BLOCKED` with blocker:
`verification failed after 3 attempt(s): agent produced no file changes`.

This is **correct, safe behavior**, not a regression:

- `agent-loop init` explicitly states the default `fake` provider only succeeds
  inside `demo`; for a real `--idea` plan you must configure a real provider.
- On an arbitrary idea the fake provider produces no real code, so the
  **deterministic verifier refuses to mark the slice done**. The agent cannot
  self-certify completion.
- Progress stayed at `verified-completed/total = 0/1`, proving the verifier
  remains the sole authority over completion.

The dirty-tree refusal on the first `run --auto` is likewise the intended git
safety guard (commit/stash or set `git.allowDirty`).

## Final status

**GATE: PASS.** Baseline is green. Real-provider live smoke (Claude + Codex),
browser verification, and the GitHub PR flow were previously verified on
`live-real-provider-smoke`. Proceeding to add the interview/intake wizard and
GitHub triage/Kanban automation **without weakening the deterministic safety core**.
