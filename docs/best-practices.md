# How it works & best practices

A practical guide to running `agent-loop` safely and getting good results. For the deep
dives, follow the links to the focused docs; this page is the operating playbook.

## What agent-loop is (in one paragraph)

agent-loop turns an idea or a GitHub issue into a **validated plan of small slices**, then
for each slice runs an AI worker against a fresh context pack, reads the **real git diff**,
and hands it to a **deterministic verifier** (tests, build, typecheck, lint, plus safety
scans for secrets, out-of-scope edits, `.git`/symlink escapes, test-weakening, merge
markers). Only a verifier `pass` produces a scoped commit; a `fail` triggers a bounded
fixer retry; a hard violation `blocks` the slice with a written report. When every slice is
committed, a final verification runs the whole project's checks. **The AI agent is an
untrusted worker; objective runtime evidence is the source of truth.** See
[architecture.md](architecture.md) and [verification.md](verification.md).

## The core principle

> **Completion = `verified-completed / total` slices — never an agent's claim.**
> The deterministic verifier is the sole completion authority. The optional AI reviewer is
> advisory and can *never* upgrade a failed check. A human always merges.

## The safety model (what the tool will never do)

- **No auto-merge, no auto-deploy, no auto-closing issues** — these capabilities do not
  exist in the tool, by design.
- GitHub `triage` / `watch` / `project` / `pr review`-comment default to **dry-run**; every
  external write needs an explicit `--apply`.
- Pull requests are **draft** by default.
- Interview / triage / recommendations only ever **strengthen** safety (forbidden paths are
  unioned, checks added, risk raised to a floor and never lowered).
- `riskPolicy.globalForbiddenPaths` (`.env`, secrets, `.git`, …) is always enforced.

See [security-model.md](security-model.md).

## First-time setup

```bash
agent-loop init        # scaffold .agent-loop/ (config + layout), add .gitignore entry
agent-loop doctor      # verify Node ≥22.5, git, and provider health
agent-loop demo        # deterministic end-to-end run, no API keys — confirms it works
```

The default `fake` provider only completes inside `demo`. For real work, configure a
provider (Claude / Codex / opencode) in `.agent-loop/config.yml` and re-run `doctor`. See
[configuration.md](configuration.md) and [provider-adapters.md](provider-adapters.md).

## Recommended defaults (keep these until you have a reason not to)

| Setting | Recommended | Why |
| --- | --- | --- |
| `execution.concurrency` | **1** | One slice at a time is easiest to follow and safest. |
| Provider for first runs | **one** real provider | Fewer moving parts while you build trust. |
| PRs | **draft** | A human reviews and merges; nothing ships automatically. |
| `auto` | **false** | Keeps the human approval gate on `run`. Turn on only deliberately. |
| Browser verification | **on for UI changes** | Captures real screenshots as evidence. |
| Interview | **quick or standard** | Clarifies intent before slicing; standard for product changes. |

## Recommended workflows

### Local idea → working branch

```bash
agent-loop plan --idea "Add ticket search" --interview standard   # planning only
agent-loop run --watch                                             # approval gate + live dashboard
```

Review the plan before running. `run --auto` removes the approval gate — use it only
deliberately. Progress: `agent-loop status` / `inspect` / `watch`.

### GitHub issue → draft PR (the safe order)

```bash
agent-loop github triage --repo o/n --issue 123                       # read-only: is it ready/low-risk?
agent-loop github import --repo o/n --issue 123 --interview quick      # preview the plan (no run, no writes)
agent-loop github run-issue --repo o/n --issue 123 --auto --pr --apply --interview quick   # execute → draft PR
agent-loop github pr review --repo o/n --pr <PR#>                      # plain-English evidence report
```

`run-issue` **starts the autonomous loop immediately** (it is not a preview) and spends
provider tokens; `--apply` lets it write status labels and open the draft PR. Then read the
verdict and **merge by hand** if happy. See [github-triage-kanban.md](github-triage-kanban.md)
and [github-integration.md](github-integration.md).

### Triage your backlog first

On any real repo, triage before running work so the tool tells you which issues are clear
and safe (`ready`, `needs-info`, `too-risky`, `unsupported`). Only run work on `ready`,
low-risk issues. Re-run with `--apply --comment` to write labels and clarifying questions.

### Non-technical owner → the Claude Code skill

If you'd rather not memorize commands, open the repo in Claude Code and use the
`/agent-loop` skill: it maps plain-English requests to the exact commands, confirms before
anything that writes/executes/spends, and explains results in plain English. See
[claude-code-skill.md](claude-code-skill.md) and
[nontechnical-pr-review.md](nontechnical-pr-review.md).

## Reading a PR review verdict

| Verdict | Meaning | Do |
| --- | --- | --- |
| 🟢 SAFE TO REVIEW | All automatic checks passed | Read the report, do the manual checks, **merge by hand** |
| 🟡 NEEDS HUMAN DEV REVIEW | Checks passed but signals to confirm | Ask a developer first |
| 🔴 DO NOT MERGE | Incomplete / failed checks / reviewer block | Do not merge |
| ⛔ BLOCKED | A hard safety rule stopped the work | Do not merge; developer needed |

"SAFE TO REVIEW" means *trustworthy enough to review* — not *merge blindly*. A "NOT CHECKED"
guard is a gap, not a pass.

## When a run gets stuck

A `BLOCKED` run is the **safety system working**, not a crash. Diagnose read-only, fix the
root cause, then resume:

```bash
agent-loop status && agent-loop inspect && agent-loop logs   # what stopped it, what's committed
# …fix the root cause (e.g. scope, a real test failure)…
agent-loop retry                                             # re-attempts unfinished work only
```

agent-loop self-heals stale run locks and resumes from the durable event log. See
[recovery.md](recovery.md) and [troubleshooting.md](troubleshooting.md).

## Do / Don't

| Do | Don't |
| --- | --- |
| Start with `demo`, then one `ready`, low-risk issue | Point `--auto` at a vague, high-risk issue on day one |
| Keep concurrency 1 and draft PRs while building trust | Add `--no-draft`, `--yes`, or unbounded `github watch` casually |
| Read the PR review verdict and do the manual checks | Treat "SAFE TO REVIEW" as "safe to merge unread" |
| Let the verifier decide completion | Look for a skip-checks/no-verify flag (there isn't one) |
| Merge by hand on GitHub | Expect the tool to merge, deploy, or close issues |

## Cost & limits

- Real runs spend provider tokens; keep concurrency low and prefer `--once`/bounded
  `--max-iterations` for `github watch`.
- The tool checks that code is safe and tests pass — it does **not** judge whether a feature
  is the right product decision. That stays with you.

## Map of the docs

- [architecture.md](architecture.md) · [verification.md](verification.md) ·
  [state-machine.md](state-machine.md) · [event-schema.md](event-schema.md)
- [configuration.md](configuration.md) · [provider-adapters.md](provider-adapters.md) ·
  [security-model.md](security-model.md) · [recovery.md](recovery.md)
- [github-triage-kanban.md](github-triage-kanban.md) ·
  [github-integration.md](github-integration.md) ·
  [interview-intake.md](interview-intake.md) ·
  [interview-recommendations.md](interview-recommendations.md)
- [nontechnical-pr-review.md](nontechnical-pr-review.md) ·
  [claude-code-skill.md](claude-code-skill.md) · [operations.md](operations.md) ·
  [terminal-dashboard.md](terminal-dashboard.md) · [troubleshooting.md](troubleshooting.md)
