# Final Readiness — Phase 1 Baseline Gate

**Date:** 2026-06-22
**Branch:** `final-realistic-readiness-validation`
**Commit:** `39ec20f7adf3d7438a1968c113f70816106bd714` (`39ec20f`)
**Baseline branch source:** `live-github-full-e2e-and-interview-recommendations` @ `39ec20f` (verified tip matches prior report)
**Working tree:** clean
**Host:** macOS (Darwin 25.3.0), Node v22.22.1, npm 10.9.4

## Environment / tooling detected

| Tool | Version | Notes |
| --- | --- | --- |
| node | v22.22.1 | ≥ 22.5 required (uses built-in `node:sqlite`) — OK |
| npm | 10.9.4 | OK |
| claude (Claude Code) | 2.1.172 | real provider available |
| codex (codex-cli) | 0.141.0 | real provider available |
| gh | 2.93.0 | authenticated as `abtrk95` |
| gh token scopes | `gist, read:org, repo, workflow` | **no `project` scope** → GitHub Projects v2 will be PARTIAL/BLOCKED |

## Commands run & results

| Command | Result | Evidence |
| --- | --- | --- |
| `npm ci` | PASS | 188 packages added, audited 189 in ~2s. 3 low-severity (dev-only). |
| `npm run typecheck` | PASS (exit 0) | `tsc -p tsconfig.json --noEmit`, no errors |
| `npm run lint` | PASS (exit 0) | `eslint .`, no errors |
| `npm run test` (vitest) | PASS | **225 passed \| 5 skipped (230)**, 31 test files, ~24s wall |
| `npm run check` | PASS | typecheck && lint && test all green |
| `npm run build` | PASS | `tsc -p tsconfig.build.json`, chmod 0755 binary |
| `node dist/bin/agent-loop.js demo` | PASS | **COMPLETED 3/3 slices verified** in throwaway repo, dashboard rendered |
| `npm audit --omit=dev` | PASS | **found 0 vulnerabilities** (prod deps clean) |
| `npm pack --dry-run` | PASS | `agent-loop-0.2.0-rc.1.tgz`, 403.9 kB, 308 files, unpacked 1.6 MB |

### Skipped tests (5) — expected, opt-in
- `test/integration/provider-smoke.test.ts` — 4 skipped: env-gated probes that invoke the **real** `claude`/`codex`/`opencode` CLIs (run only when the live env flag is set; hermetic argv-stub variants run by default).
- `test/integration/github-pr.test.ts` — 1 skipped: env-gated live `gh` PR test.

These are deliberately opt-in (no paid/live calls in the default suite). They are exercised live in later phases of this validation.

### `npm audit` (full, incl. dev) — informational
- 3 **low** severity, all dev-only: `@eslint/plugin-kit` ReDoS (GHSA-xffm-g5w8-qvg7). Not in the shipped `files` set; `--omit=dev` is clean. Non-blocking.

## Package facts relevant to classification
- `version`: `0.2.0-rc.1`
- `private: true` — **not publishable as-is** (blocks unqualified PRODUCTION READY).
- No `LICENSE` file (all rights reserved, by design pending decision) — **blocks unqualified PRODUCTION READY**.
- `files`: `dist`, `docs`, `README.md`, `THIRD_PARTY_NOTICES.md` — pack contents sane.

## Verifier-safety unit/integration coverage already present (sampled from the green run)
Observed passing in this baseline run (relevant to Phase 10 negative controls):
- rejects out-of-scope edits and never commits them
- blocks (never commits) when a secret appears in the diff
- blocks on writes under `.git` (structural escape)
- blocks on test weakening (`.skip`)
- blocks when a required check fails, with no commit
- planted executable `post-commit` hook does NOT fire during a run (RCE fix)
- config `riskPolicy.globalForbiddenPaths` honored
- stale control intent does not sabotage a fresh run
- provider fallback / reviewer consensus (hermetic)
- safe parallel worktrees: concurrent independent slices integrate; overlapping scope serializes

## Verdict

**BASELINE PASSES. Safe to continue.** No baseline blocker found; no baseline fix required.

Carry-forward limitations already known and confirmed at baseline (not regressions):
- `private: true` + no LICENSE → cannot claim unqualified production-ready.
- gh token lacks `project` scope → GitHub Projects v2 sync expected PARTIAL.
- Live multi-provider routing within one run proven only hermetically so far (to be tested live in Phase 9).
