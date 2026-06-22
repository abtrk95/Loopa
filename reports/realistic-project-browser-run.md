# Phase 8 — Real UI / Browser Verification Run (Issue 2)

**Date:** 2026-06-22 · Repo: `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042`
**Provider:** Claude Code 2.1.172 (`claude-sonnet-4-6`). **Browser engine:** CDP (real headless Google Chrome).
**Config:** `browser.enabled:true engine:auto startCommand:"npm run dev" baseUrl:http://127.0.0.1:5173 routes:["/"] failOnConsoleError:true required:true`.

## Result: PASS — and BOTH the block-on-failure and pass-on-clean paths proven

This phase ran three times; each attempt was instructive and together they validate every Phase-8 requirement.

### Attempt A — BLOCKED (app not ready) → exposed a test-harness config issue
- Verifier PASSED, then browser: *"app did not become ready at http://127.0.0.1:5173/ within 60000ms"* → engine `none` → **required browser failed → slice BLOCKED, no commit, no PR**.
- **Root cause (mine, not agent-loop):** Vite 6 binds only to `localhost`/`::1` ("use --host to expose"); probing `127.0.0.1` returned connection-refused while `localhost` returned 200. **Fix:** set the app's dev script to `vite --host 127.0.0.1`. (An agent-loop-side robustness note is in the coverage matrix.)

### Attempt B — BLOCKED (console error) → screenshot + console capture + required-block all proven
- Verifier PASSED → CDP browser navigated `/` (status 200) → **captured a real 41 KB PNG screenshot** (`S-001__root.png`) → **captured a console error**: *"Failed to load resource: the server responded with a status of 404 (Not Found)"* → with `failOnConsoleError:true required:true` the slice **BLOCKED** (no commit, no PR).
- **Root cause:** benign missing `/favicon.ico` auto-request. **Fix:** `<link rel="icon" href="data:,">` in `index.html` so the browser makes no favicon request.
- Evidence preserved: `reports/final-readiness-evidence/phase8-browser-screenshot.png`, `phase8-browser-blocked.json`.
- **Timeout cleanup verified:** `pgrep` after the run found **no lingering dev-server process** — the harness tore down the server tree.

### Attempt C — COMPLETED (clean) → browser PASS → commit → draft PR
Event order: `VERIFICATION_PASSED → BROWSER_VERIFICATION_STARTED → BROWSER_VERIFICATION_FINISHED → COMMIT_CREATED → SLICE_COMPLETED` (browser runs **after** the verifier and **before** the commit; it can never override the verifier).

| Validation | Result | Evidence |
| --- | --- | --- |
| UI works | ✓ | route `/` → HTTP 200, no console errors |
| Browser verification runs (configured) | ✓ | `engine: cdp`, real Chrome |
| Screenshot artifact created | ✓ | `S-001__root.png` (41 KB real PNG); preserved as `phase8c-browser-screenshot-PASS.png` |
| Console errors captured | ✓ | `consoleErrors: []` when clean (B captured the 404) |
| Required browser check blocks when broken | ✓ | Attempts A & B both BLOCKED with no commit/PR |
| Tests/build/typecheck pass | ✓ | independent re-verify on committed state: **test 15 passed, build PASS** |
| SLA calculation tested | ✓ | `tests/sla.test.ts` — on-track/at-risk/overdue across all four priorities, boundary cases |
| Draft PR created | ✓ | **PR #8** `isDraft=true`, base `master`, OPEN, Refs #2 |
| No auto-merge/deploy | ✓ | draft PR only; log "agent-loop never auto-merges or deploys" |
| No forbidden paths / secrets / issue close | ✓ | scoped commit `2534111`, issue #2 OPEN |

### What the agent built (Attempt C)
Status + priority filters on the ticket list (`TicketList.tsx`, `App.tsx`), an `src/utils/sla.ts` SLA calculator (age + priority → on-track/at-risk/overdue), SLA badges with styles (`index.css`), and `tests/sla.test.ts`. Scoped commit `2534111` (trailer `agent-loop-slice: S-001`), 5 files, +159/-11.

## Browser-verification capabilities confirmed
Real CDP/Chrome engine · real PNG screenshots · real console-error capture · `failOnConsoleError` gating · `required:true` blocks the slice (advisory otherwise) · runs only after a verifier pass · **always tears the server down** (timeout cleanup). Artifacts written owner-only under `.agent-loop/artifacts/ui-smoke/`.

**Phase 8 verdict: PASS.** Browser/UI verification is real and correct on a live repo, in both its blocking-failure and passing-success modes, and the result is a human-review-ready draft PR.
