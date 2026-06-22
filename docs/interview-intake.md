# Interview / intake wizard

agent-loop can **interview you before it slices**. The interview clarifies the
objective, then feeds the answers into the *same deterministic planner* — it does not
change how work is executed or verified.

> **One rule above all:** the interview improves *planning only*. It can only ever
> **strengthen** safety. It never weakens the verifier, never marks work done, and
> completion stays `verified-completed / total` slices.

For **every** question the interview now also gives a grounded **recommendation**
(recommended answer + why + alternatives + risk + safe default + required/optional) and
asks **agent/model orchestration** questions (planner/workers/reviewer/fixer/fallback/
concurrency). See **[interview-recommendations.md](./interview-recommendations.md)**.

Source: `src/intake/interview.ts`, `src/intake/recommend.ts`, `src/cli/commands/interview.ts`, `src/cli/prompter.ts`.

## Commands

```bash
agent-loop interview                       # interview-first, then plan (standard mode)
agent-loop interview quick|standard|strict # pick the depth
agent-loop plan --idea "..." --interview          # interview, defaulting to standard
agent-loop plan --idea "..." --interview strict   # deeper clarification before slicing
agent-loop plan --prd ./prd.md --interview        # enrich a PRD with an interview
agent-loop plan --issue 123 --interview           # (via github import) clarify an issue
agent-loop plan --idea "..." --interview --accept-recommended   # take all recommendations, no prompts
agent-loop interview standard --no-orchestration  # objective questions only (skip agent/model qs)
agent-loop interview standard --accept-recommended --write-config  # persist chosen orchestration
```

Anything you can plan from (`--idea`, `--prd`, `--spec`, `--readme`, `--issue`,
`--stdin`) can be combined with `--interview`. With no input at all, `agent-loop
interview` will ask for the goal itself.

## What it asks

The interview clarifies (depending on mode):

- **Goal**, **background/context**
- **Success criteria**, **acceptance criteria** (per slice)
- **Non-goals**, **user-visible behavior**
- **Technical constraints**, **existing architecture**
- **Forbidden files/areas**, **risk level**
- **Verification commands**
- **Deployment / merge policy**
- Whether **browser verification** is needed
- Whether **GitHub / PR integration** is needed
- Whether the task can **run autonomously**
- **Human approval checkpoints**
- **Stop / blocker conditions**
- **Agent/model orchestration** (`standard`+): planner, worker(s), concurrency, reviewer,
  required-vs-advisory browser verification; and at `strict`: reviewer consensus, fixer
  strategy, fallback provider, switch-on-retry. See
  [interview-recommendations.md](./interview-recommendations.md).

Questions already answered by your input are skipped (e.g. a PRD that already lists
acceptance criteria won't be asked for them again). Every asked question comes with a
recommendation; press Enter to accept it, or `--accept-recommended` to accept them all.

## Modes

| Mode | Asks | Use when |
| --- | --- | --- |
| `quick` | only the few *critical-missing* questions (goal, acceptance criteria, verification) | you mostly know what you want and just want gaps filled |
| `standard` | practical product + technical questions | the default — a balanced clarification pass |
| `strict` | the full detailed set, including architecture, merge policy, human checkpoints, stop conditions | high-stakes work you want fully pinned down before any slice |

`quick ⊂ standard ⊂ strict`.

## Interactive vs. non-interactive

- **Interactive** (a TTY, not `--auto`): each unanswered question is shown with its full
  recommendation; pressing Enter accepts the **recommended** value, typing overrides it.
- **Non-interactive** (`--auto`, or no TTY, or piped): the interview **never hangs**. For
  each missing answer it derives a conservative default and **records it as an
  assumption**. Low-confidence assumptions are tagged `(low confidence — verify)`.
- **Scripted** (`--answers <file>`): supply a JSON object of answers (the same keys the
  interview gathers) for a fully reproducible, hermetic run. Useful in CI and for
  re-running a clarified plan.

```jsonc
// answers.json
{
  "acceptanceCriteria": ["exports valid CSV", "handles empty input"],
  "verificationCommands": ["npm test", "npm run build"],
  "forbiddenPaths": ["src/legacy/**"],
  "risk": "high",
  "nonGoals": ["xlsx export"]
}
```

```bash
agent-loop plan --idea "Add CSV export" --interview standard --answers answers.json --auto
```

## Safety-critical blocking

In `--auto`, if a **safety-critical** answer is missing and there is **no safe default**,
the interview **blocks** instead of inventing a plan. The canonical case:

> a **high-risk** objective (auth/payment/migration/production/…) with **no verification
> commands** (none detected in the repo, none supplied) — there is no objective way to
> confirm such work, so agent-loop refuses to plan it unattended.

```
error [intake]: safety-critical: this objective looks high-risk but has no verification
commands. Re-run interactively (drop --auto) or provide verification … before planning.
```

Fix it by running interactively, answering the verification question, adding
`verification.commands` to `.agent-loop/config.yml`, or passing `--answers` with
`verificationCommands`.

## What the interview produces

The interview updates the same artifacts a normal plan does:

- `.agent-loop/objective.md` — goal, background, success criteria, constraints, non-goals.
- `.agent-loop/assumptions.md` — every recorded assumption (with confidence markers and a
  line noting the plan was shaped by an interview in `<mode>` mode).
- `.agent-loop/plan.json` — the validated plan. The generated plan includes, per the
  task contract: clear success criteria, **acceptance criteria per slice**, **allowed
  paths**, **forbidden paths**, **required checks**, **risk level**, **dependencies**, and
  human-decision-gate notes when requested.

You can **edit `plan.json` by hand** after the interview and re-run; it is re-validated
on load.

## How answers map to the plan (strengthen-only)

| Answer | Effect on the plan |
| --- | --- |
| forbidden paths | **unioned** into `riskPolicy.globalForbiddenPaths` (built-in protections like `.env`, `secrets/**`, `.git/**` are never removed) and per-slice `forbiddenPaths` |
| verification commands | **added** (deduped) to `verification` → become required checks for every slice and run at final verification |
| risk | a **floor**: a slice's risk may be *raised* to it, never lowered |
| acceptance criteria | become the slice's `acceptanceCriteria` (for an idea, a single slice is synthesized to carry them) |
| success criteria | added as advisory **human** success criteria (never gate the deterministic verifier) |
| non-goals / constraints / architecture / merge policy / stop conditions | recorded on the objective (constraints / non-goals) for context |
| human checkpoints / browser verification | recorded as slice notes / objective context |

Because every mapping is a union/add/raise, **the interview can never widen scope into a
forbidden area, remove a check, or downgrade risk.**

## What it does NOT do

- It does **not** execute work, mark slices done, or change the verifier.
- It can **configure** orchestration (planner/workers/reviewer/concurrency, and the
  `browser.enabled` / `github.enabled` switches) from accepted answers — applied to the
  current run and, with `--write-config`, persisted — but enabling browser verification
  still needs a `startCommand`/`baseUrl`, and GitHub writes still require explicit
  `--apply`/`--pr`. Nothing executes implicitly.
- It is **strengthen-only**: it never enables autonomy on a high-risk objective, never
  lowers risk, never removes a check, and never widens scope into a forbidden area.
- It does **not** set auto-merge/deploy (there is no such path anywhere in agent-loop).

The interview is the **front** of the safe non-technical workflow (clarify intake →
strengthen-only orchestration → run → draft PR → **plain-English PR review**). When the
work lands as a draft PR, [nontechnical-pr-review.md](nontechnical-pr-review.md) explains
how a non-technical owner reads the evidence-based verdict and decides whether to merge.

## Tests

`test/unit/interview.test.ts` covers: quick/standard/strict selection, interactive
(scripted prompter) and non-interactive auto assumptions, the safety-critical blocker
(and its resolution), idea+interview and PRD+interview producing valid plans, that
built-in forbidden paths are never removed, and that the resulting plan stays editable
and valid.
