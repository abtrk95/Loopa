# Interview recommendations & agent/model orchestration

The interview doesn't just *ask* questions — for **every** question it gives you a
grounded **recommendation**: a recommended answer, *why* it fits your input, the
realistic alternatives, the risk/impact, the conservative safe default, and whether the
answer is required or optional. It also adds a set of **agent/model orchestration**
questions so you can choose planner / workers / reviewer / fixer / fallback / concurrency
right in the interview.

> **Safety invariant:** a recommendation can only **pick providers/models/concurrency**
> (which the deterministic verifier always dominates) or **raise a safety floor** (more
> checks, required browser verification, human gates). It never weakens the verifier,
> and it never enables autonomy on a high-risk objective. Completion stays
> `verified-completed / total` slices.

Source: `src/intake/recommend.ts` (pure engine), `src/intake/interview.ts`
(`applyOrchestration`, orchestration catalog), `src/cli/commands/interview.ts` (wiring),
`src/cli/prompter.ts` (`askRecommended`).

## The shape of a recommendation

Every question is presented like this:

```
Question:
  How many slices may run in parallel (concurrency)?

Recommended:
  1

Why:
  Begin conservatively at concurrency 1. Overlapping scopes serialize anyway; raise
  this only once slices are proven independent.

Alternatives:
  - 1 — sequential (recommended to start)
  - 2 — parallel for clearly independent slices

Risk:
  Higher concurrency parallelizes independent, parallel-safe slices via isolated
  worktrees, but increases integration churn. The scheduler never parallelizes
  overlapping scopes.

Default:
  1 (sequential)

Optional.
```

Pressing **Enter** accepts the recommended value. Typing anything overrides it. The
chosen value (recommended or typed) is recorded as a decision in `assumptions.md`.

## What the recommendation is based on

`computeSignals()` + `recommendationFor()` reason over:

- the **initial idea / PRD / issue text** (keyword analysis for risk, UI, GitHub, multi-slice),
- the **detected repo stack** and `package.json` scripts (`src/intake/detect.ts`),
- the **detected verification commands** (the same checks a developer runs),
- **git state** (clean tree, branch),
- the **available providers** and whether they're installed (`agent-loop providers` / `doctor`),
- the **current config** (defaults you've already set),
- the **risk level** of the task (small / medium / high), and whether
- **UI/browser** verification or a **GitHub/PR** workflow is implied.

## Agent / model orchestration questions

Added at `standard` (and more at `strict`); `quick` asks none of these:

| Question | Recommends | Maps to config |
| --- | --- | --- |
| Planner provider/model | strongest installed real provider (claude › codex › opencode), else `fake` | `roles.planner` |
| Worker provider(s)/model(s) | a **single** capable worker (conflict-free start) | `roles.workers` |
| Concurrency | **1** (sequential; raise once slices proven independent) | `execution.concurrency` |
| Reviewer provider/model | a **distinct** model for high-risk work, else `none` | `roles.reviewer` |
| Browser verification required? | required for high-risk UI, else advisory | `browser.required` |
| Reviewer consensus? | yes for high-risk with ≥2 providers | `routing.reviewerConsensus` |
| Fixer strategy | `same-as-worker` | `roles.fixer` |
| Fallback provider | a distinct provider when ≥2 installed, else `none` | `routing.fallbackOrder` |
| Switch on retry? | yes when an alternative provider exists | `routing.switchProviderOnRetry` |

The objective questions **autonomous**, **GitHub integration**, and **browser
verification** also feed config (`auto`, `github.enabled`, `browser.enabled`) — subject
to the strengthen-only rule below.

## Flags

```bash
# Take every recommended answer with no prompts (fast path):
agent-loop plan --idea "Add a billing settings page" --interview standard --accept-recommended

# Skip just the orchestration questions (objective interview only):
agent-loop interview standard --no-orchestration

# Persist the chosen orchestration to .agent-loop/config.yml for later `run`s:
agent-loop plan --idea "..." --interview standard --accept-recommended --write-config
```

`--accept-recommended` is the "accept all recommendations" fast path. It works
non-interactively too (great for CI and for previewing a sensible config).

## How orchestration choices take effect

`applyOrchestration()` turns the accepted answers into a **config override** with the
same shape as `.agent-loop/config.yml`. The override is:

1. **applied in-memory** to the current session — so a single
   `plan --interview` / `github run-issue --interview` command runs with the chosen
   planner/workers/reviewer/concurrency, and
2. **persisted** to `.agent-loop/config.yml` when you pass `--write-config`, so later
   `run` / `run-issue` invocations pick it up through normal config precedence.

After the plan, the CLI prints the resolved orchestration so you see exactly what the run
will use:

```
Orchestration (verifier remains authoritative; AI roles can never override it):
  planner:     claude
  workers:     claude
  reviewer:    codex
  fixer:       same-as-worker
  concurrency: 1 (sequential)
  fallback:    codex  switch-on-retry: true
  consensus:   1  browser: advisory  github: on  auto: false
```

## Strengthen-only guarantees

- **Autonomy is never enabled on high-risk work.** Even if you accept "run
  autonomously", `applyOrchestration` keeps `auto=false` for a high-risk objective and
  records why. (Completion is verifier-gated regardless; nothing is ever auto-merged or
  deployed.)
- Orchestration only ever **chooses providers/models/concurrency** or **raises** a floor
  (e.g. makes browser verification *required* instead of advisory). It never touches
  `verification` or `riskPolicy` to relax a guard.
- The **deterministic verifier remains the sole completion authority.** No planner,
  worker, reviewer, reviewer-consensus, or fallback can pass a slice the verifier failed
  (out-of-scope edits, secrets, failed checks, forbidden-path writes). See
  `docs/provider-adapters.md` and `docs/verification.md`.

## Tests

- `test/unit/recommend.test.ts` — the pure engine: signal heuristics, per-question
  recommendations (objective + orchestration), provider preference + fallback, full-field
  completeness for every recommendable key, and rendering.
- `test/unit/interview.test.ts` — orchestration question selection by mode, the
  `--accept-recommended` fast path (records decisions), the interactive `askRecommended`
  flow (accept-on-Enter, type-to-override), and `applyOrchestration` strengthen-only
  behavior (no autonomy on high-risk; browser-required only when verification is on;
  `fake`/`none` sentinels never selected as real providers).
