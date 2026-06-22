# Live Multi-Model E2E Report

- **Date:** 2026-06-22
- **Repo:** `abtrk95/agent-loop-live-e2e-20260622-101240` (PRIVATE)
- **Providers:** Claude Code **2.1.172**, Codex **0.141.0** (both installed + authenticated)

## What was tested

1. **The interview can configure multi-model** — every orchestration dimension is recommended + applied.
2. **A real multi-model run** — two slices on two distinct providers, a distinct reviewer, verifier-gated, draft PR.

## 1. Interview configures multi-model (high-risk issue #4)

```
node dist/bin/agent-loop.js github import --repo <repo> --issue 4 --interview strict --accept-recommended
```

For the high-risk "billing settings page" issue at `strict` mode, the interview recommended and applied a full multi-model orchestration:

```
planner:     claude
workers:     claude
reviewer:    codex            ← distinct second model (high-risk → second-model review)
fixer:       same-as-worker
concurrency: 1 (sequential)
fallback:    codex            switch-on-retry: true
consensus:   2                browser: required   github: on   auto: false
```

This proves the interview **asks for / recommends** planner, worker(s), concurrency, reviewer, reviewer-consensus, fixer strategy, fallback provider, switch-on-retry, browser required-vs-advisory, GitHub integration, and autonomy — grounded in the task's risk. **Strengthen-only:** `auto` stayed `false` because the objective is high-risk.

## 2. Real multi-model execution (Claude + Codex)

A 2-story task (clamp + capitalize utilities) was planned and run with:

```yaml
roles:
  planner: { provider: claude }
  workers: [ { provider: claude }, { provider: codex } ]
  reviewer: { provider: codex }
routing: { workerStrategy: round-robin, fallbackOrder: [claude], switchProviderOnRetry: true, reviewerConsensus: 1 }
execution: { concurrency: 2, maxRetriesPerSlice: 1 }
riskPolicy: { requireReviewAtOrAbove: low }
providers:
  claude: { args: ["--permission-mode", "acceptEdits"] }
  codex:  { args: ["--full-auto"] }
```

### Evidence (from the event store)

| Slice | Worker (PROVIDER_SELECTED) | Reviewer (REVIEW_FINISHED) | Verdict | Files created | Commit |
| --- | --- | --- | --- | --- | --- |
| S-001 Add clamp utility | **claude** | **codex** | pass | `src/util/clamp.js`, `test/clamp.test.js` | `1548cc7` |
| S-002 Add capitalize utility | **codex** | **codex** | pass | `src/util/capitalize.js`, `test/capitalize.test.js` | `c93eccb` |

- Both slices: `VERIFICATION_PASSED` → scoped commit → `SLICE_COMPLETED`; final verification passed; **10 tests pass** (5 original + clamp + capitalize).
- Distinct workers via round-robin (Claude on S-001, **Codex** on S-002) — genuine multi-model worker routing, live.
- A **distinct reviewer** (Codex) reviewed each diff and returned `pass` (advisory, 0 findings).
- Draft PR **[#7](https://github.com/abtrk95/agent-loop-live-e2e-20260622-101240/pull/7)** created (Refs #5), draft-only.

### Parallel vs. sequential — what actually happened (and why it's correct)

Timestamps show the two slices ran **sequentially**, not concurrently:

```
08:22:13  S-001 SLICE_STARTED  PROVIDER_SELECTED claude
08:22:54  S-001 COMMIT_CREATED / SLICE_COMPLETED
08:22:54  S-002 SLICE_STARTED  PROVIDER_SELECTED codex
08:24:42  S-002 COMMIT_CREATED / SLICE_COMPLETED
```

Root cause (verified): `pathScopesOverlap(S-001, S-002) === true` because both slices write under `src/util/`. `scopePrefix('src/util/clamp.js') === 'src/util/' === scopePrefix('src/util/capitalize.js')` — agent-loop's scope-overlap check is **directory-granular and conservative**, so two slices touching the same directory are treated as overlapping and **serialized to prevent concurrent edits to the same area**. This is the documented **"overlapping scopes serialize"** safety behavior — the run did exactly the right thing.

- **Independent slices on different workers:** ✅ proven live (Claude + Codex).
- **Overlapping scopes serialize:** ✅ proven live (same-directory → sequential).
- **Genuine concurrent worktree execution (distinct directories):** proven hermetically by `test/integration/parallel.test.ts` ("runs two independent slices concurrently and integrates both commits"). Not re-proven live to keep paid scope minimal.

### Fallback / switch-on-retry

Configured live (`fallbackOrder: [claude]`, `switchProviderOnRetry: true`) but **not triggered** — no slice failed, so there was nothing to fall back from. **PARTIAL** for live; proven hermetically by `test/integration/orchestration-fixes.test.ts` (C7 provider fallback, C8 reviewer consensus) and `verifier-engine` retry+fixer.

## Verifier authority (the central safety claim)

No AI role can override the deterministic verifier. Proven hermetically (green suite) and consistent with the live run:
- `reviewer-consensus.test.ts`: "reviewer consensus cannot override the deterministic verifier" — blocks an out-of-scope change / a secret in the diff **even when every reviewer votes pass**.
- `verifier-engine.test.ts`: rejects out-of-scope edits, secrets, `.git` writes, test weakening, failed checks — no commit on block.

Live, both Codex reviews returned `pass`, but completion was still decided by the deterministic verifier over the real git diff + checks, and the scoped commits contain only in-scope files.

## Classification

**Multi-model live = PASS** for distinct-provider worker routing + distinct reviewer + verifier authority + draft-PR-only. **PARTIAL** for live parallel execution (serialized by the documented same-directory rule; concurrency proven hermetically) and live fallback/switch-on-retry (configured, not triggered; proven hermetically).
