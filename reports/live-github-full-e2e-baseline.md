# Live GitHub Full E2E — Phase 1 Baseline Gate

- **Date:** 2026-06-22
- **Branch:** `live-github-full-e2e-and-interview-recommendations` (from `github-triage-and-interview` @ 721a1ba)
- **Node:** v22.22.1  **npm:** 10.9.4  **gh:** 2.93.0
- **Working tree at start:** clean

All baseline commands were run from `/Users/abtrk/Dev/loop/agent-loop` and captured to `/tmp/agentloop-baseline.log`.

| # | Command | Result | Exit |
|---|---------|--------|------|
| 1 | `git status` | clean tree on new branch | 0 |
| 2 | `npm ci` | dependencies installed | 0 |
| 3 | `npm run check` (typecheck + lint + vitest) | **30 files, 197 passed, 5 skipped** in 23.3s | 0 |
| 4 | `npm run build` (`tsc -p tsconfig.build.json` + chmod) | dist built, bin chmod 755 | 0 |
| 5 | `node dist/bin/agent-loop.js demo` | **COMPLETED (3/3 slices verified)**, fake provider | 0 |
| 6 | `npm audit --omit=dev` | **found 0 vulnerabilities** | 0 |
| 7 | `npm pack --dry-run` | `agent-loop-0.2.0-rc.1.tgz`, 303 files, pkg 380.6 kB / unpacked 1.5 MB | 0 |

## Notable test evidence (already-green safety properties relevant to this lab)

- `verifier-engine` — deterministic verifier rejects out-of-scope edits, secrets, `.git` writes, test weakening, failed checks; never commits on block.
- `reviewer-consensus` — runs each DISTINCT reviewer once; **cannot override the deterministic verifier** (blocks out-of-scope / secret even when every reviewer votes pass).
- `orchestration-fixes` — provider fallback (C7), reviewer consensus N>1 (C8), agent self-commit blocked (C1), stale parallel-worktree branch recovery (C5).
- `parallel` — two independent slices run concurrently; **overlapping scope serializes** (no corruption).
- `github-triage` (17) / `github-e2e` (2) / `github-pr` (7) — triage classifies before work; run-issue ends verified-complete with a **draft** PR; **no merge/deploy/close verb** anywhere on the PR+issue surface; project sync degrades gracefully when no project exists.
- `e2e-hardening` — git-hook RCE fix (planted post-commit hook does NOT fire), config forbidden-path enforcement, version/logs/bad-input CLI.

## Environment for live phases

- `gh auth status`: logged in as **abtrk95** (active), scopes `gist, read:org, repo, workflow`.
  - **No `project` scope** → GitHub Projects v2 *creation* is expected to be unavailable. Per the spec, GitHub Project live status will be marked **PARTIAL** and the lab continues with labels + PRs.

## Verdict

**Baseline PASS.** No baseline-blocking issues. Proceeding to Phase 2 (interview audit) and Phase 3 (recommendations implementation).
