# Verification — the deterministic heart of the loop

The verifier is the component that makes "the agent is a worker, not the source of
truth" real. It decides whether a slice's work is acceptable using **only** objective,
model-independent evidence:

- the real git diff (including untracked files),
- the set of changed paths,
- the slice, plan, and config policies,
- the exit codes / output of required checks.

It never reads the agent's claims. A model reviewer may add semantic findings
afterwards, but it can **never** override a failed deterministic check here.

Source: `src/verify/verifier.ts`, `src/verify/checks.ts`, `src/git/scope.ts`.

## Verdicts

| Verdict | Meaning | Engine reaction |
| --- | --- | --- |
| `pass` | All safety scans clean and all required checks passed. | Eligible to commit → (optional review) → `COMPLETED`. |
| `fail` | A recoverable problem. | Bounded fixer retry; if retries exhausted, the slice is blocked. |
| `block` | A hard violation. | Stop the slice immediately; not auto-retryable. Write a blocker report. |

`fail` is recoverable (the agent might fix it next attempt); `block` indicates the
agent did something it must never do, so retrying is pointless and unsafe.

## The check pipeline (in order)

For a normal slice, the verifier runs these stages. The cheap, safety-critical scans
run first and **short-circuit** before the expensive command checks if anything has
already downgraded the verdict.

1. **Empty-diff guard.** If the agent changed no files (excluding `.agent-loop/`), the
   verdict is `fail` with reason "agent produced no file changes". An agent that says
   "done" without touching the repo gets nowhere — this is the most direct enforcement
   of the core principle.

2. **Scope policy** (`evaluateScope`). Every changed path must match the slice's
   `allowedPaths`. Paths matching `forbiddenPaths` or the plan's
   `globalForbiddenPaths` → `block`. Paths outside `allowedPaths` → `fail`.

3. **Structural safety** (`structuralScan`). Detects:
   - `git-internal` (writes under `.git/`) → `block`
   - `traversal` (`../` escapes) → `block`
   - `symlink-escape` (a symlink pointing outside the repo) → `block`
   - `submodule` changes → `fail`
   - `binary` files → `flag` (recorded, not fatal; configurable via `flagBinary`)

4. **Secret scan** (`detectSecretsInDiff`, if `verification.detectSecrets`). Scans the
   diff *including untracked content* for credential shapes. Any hit → `block`. (This
   is independent of redaction, which protects *stored/displayed* data; this scan stops
   a secret from being *committed*.)

5. **Diff size.** `addedLines` must be ≤ `min(plan.riskPolicy.maxDiffLines,
   config.verification.maxDiffLines)`. Over budget → `fail`. This keeps slices small
   and reviewable and catches runaway generation.

6. **Test weakening** (`detectTestWeakening`, if `verification.detectTestWeakening`).
   Flags diffs that disable or hollow out tests (`.skip`, `.only`, commenting out
   assertions, `xit`/`xdescribe`, etc.) → `fail`. Prevents the classic "make the test
   pass by deleting the test" failure mode.

7. **Merge-conflict markers** (`detectMergeConflicts`). Scans the added diff for
   unresolved conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) → `fail`. Prevents an
   agent from committing a half-merged file.

8. **Lockfile policy.** If a lockfile changed and `plan.riskPolicy.allowLockfileChanges`
   is false → `fail`; if allowed → recorded as a `flag`.

9. **Required command checks** (the expensive stage). For each of the slice's
   `requiredChecks` (resolved against the plan's global checks), the verifier runs the
   command through the sandboxed `ProcessManager` in the work repo and evaluates its
   `expect` policy (`exit_zero` | `exit_nonzero` | `stdout_contains`). Output is
   captured to `.agent-loop/artifacts/checks/<slice>__<check>.log`. A failing required
   check → `fail`. Commands are subject to an allow/deny policy
   (`verification.allowedCommands` / `deniedCommands`): a denied command → `block`; a
   command not in a non-empty allowlist is skipped and flagged.

The final `FINAL_VERIFYING` pass (after all slices are committed) runs the plan's
global checks against the **integrated** result with `isFinal: true`, which skips the
per-slice scope/diff scans and just runs the global checks. The run only reaches
`COMPLETED` if this passes.

## Why "fresh diff" matters

The executor enforces a **clean working tree before every attempt** (`workRepo.rollback()`
discards leftovers). So the diff the verifier reads is *exactly* this attempt's output —
not a mix of prior attempts. This makes verdicts attributable and reproducible, and it
guarantees an aborted attempt can never leak half-written files into a commit.

## Scoped, attributable commits

Only after `pass` (and, when required, a passing review) does the executor create a
**scoped** commit: it stages only the verifier-confirmed changed files and commits with
a trailer:

```
S-001 Add the /health endpoint

agent-loop-slice: S-001
```

The trailer makes every commit traceable to a slice and lets recovery find a slice's
commit idempotently (`findSliceCommit`). Commit creation is also guarded by an
`idempotencyKey` on the `COMMIT_CREATED` event, so a crash between commit and event
write can't double-commit on resume.

## Required vs advisory

```
                    ┌─────────────────────────────┐
   real git diff ─► │   DETERMINISTIC VERIFIER     │ ─► pass / fail / block   (AUTHORITATIVE)
                    └─────────────────────────────┘
                                   │ pass
                                   ▼
                    ┌─────────────────────────────┐
                    │   MODEL REVIEWER (optional)  │ ─► pass / changes / block (ADVISORY)
                    └─────────────────────────────┘
```

The reviewer runs only if a reviewer role is configured and the slice's risk meets
`riskPolicy.requireReviewAtOrAbove`. It sees the diff and returns a structured verdict.
A reviewer `blocked` or `changes_requested` can stop or retry a slice, but a reviewer
**cannot** turn a verifier `fail`/`block` into a pass — the verifier already returned
before the reviewer is consulted, and the reviewer is only invoked on a verifier `pass`.

## Blocker reports

When a slice is blocked (or exhausts retries), the executor writes
`.agent-loop/reports/blocked-<slice>.md` containing the objective reason, attempt count,
the acceptance criteria, and the non-flag findings — redacted. This is the artifact a
human reads to decide whether to fix-and-`retry` or adjust the plan. The reason is
always grounded in evidence (a failing check, an out-of-scope path, a detected secret),
never in agent narration.

## UI / browser verification (implemented; advisory)

Browser/UI verification is **implemented and wired** (off by default — enable it under
the `browser` config section). After a slice passes the deterministic verifier, the
harness (`src/verify/browser.ts`):

1. **starts the app** under test as a server (`browser.startCommand`),
2. **waits** (with `startupTimeoutMs`) until `browser.baseUrl` accepts connections,
3. **navigates** each `browser.routes` entry, capturing a **screenshot** and any
   **console / page errors**,
4. **writes artifacts** to `.agent-loop/artifacts/ui-smoke/` (a `.png` or `.html`
   snapshot per route + a `<slice>__browser.json` summary), and
5. **always tears down** the app server tree and the browser engine — including on
   timeout, abort, or error (timeout cleanup).

Two engines implement the same contract:

- **`CdpBrowserEngine`** — a real headless **Chrome/Chromium** driven over the DevTools
  Protocol (zero npm deps; uses Node's built-in `WebSocket`/`fetch`). Produces **real
  PNG screenshots** and captures **real browser console errors / uncaught exceptions**.
  Selected automatically when a Chrome binary is found (`engine: auto`) or forced with
  `engine: cdp` (+ `chromePath`).
- **`HttpBrowserEngine`** — a zero-dependency fallback that performs real HTTP
  navigation against the running app, saves the served HTML as the route snapshot, and
  flags page errors from the HTTP status and an error sentinel. Selected when no Chrome
  is available, or forced with `engine: http`.

Browser verification is **advisory** by default: a failure is recorded
(`BROWSER_VERIFICATION_FINISHED` event + artifacts) and the slice proceeds. With
`browser.required: true`, a browser failure **blocks** the slice. In neither case can it
override the deterministic verifier — it runs **only after** a verifier `pass`, so it can
never turn a `fail`/`block` into success.

> **Reserved.** `roles.browser` (a provider ref) remains reserved for a future
> provider-driven browser and is distinct from the wired `browser` config section. The
> `judge` role is still reserved/unimplemented.

Tested by `test/integration/browser-verify.test.ts` against a fixture HTTP app
(startup, navigation, capture, console-error detection, timeout cleanup, lifecycle
gating) plus an opt-in real-Chrome (CDP) check.

## Testing the verifier

`test/integration/verifier-engine.test.ts` proves each control end-to-end with the fake
provider: out-of-scope edits are rejected and never committed; a secret in the diff
blocks; a write under `.git` blocks; test weakening (`.skip`) blocks; a failing required
check blocks with no commit; a blocker report is written; the fixer recovers on the
second attempt; and the reviewer is advisory (blocks when it says block, passes when it
says pass — but never overrides the verifier).
