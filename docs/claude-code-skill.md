# Claude Code skill (non-technical operator)

agent-loop ships a [Claude Code](https://claude.com/claude-code) **skill** that lets a
non-technical user operate the CLI conversationally — *"add ticket search"*, *"run issue
123"*, *"is PR 11 safe?"* — without memorizing commands or risking an unsafe action.

It is an **operator layer on top of the existing CLI**. It does not replace the CLI and it
is **not an authority** over it: the deterministic verifier remains the sole completion
authority and a human always merges.

## Files

```
.claude/skills/agent-loop/
  SKILL.md                       # the skill (loaded by Claude Code)
  README.md                      # purpose, invocation, limitations
  examples/start-from-idea.md
  examples/github-issue-flow.md
  examples/review-pr.md
  examples/progress.md
```

## How to invoke

Claude Code auto-discovers project skills under `.claude/skills/<name>/SKILL.md`. From a
Claude Code session opened in this repo:

- type `/agent-loop`, or
- speak naturally (*"triage my repo"*, *"check progress"*, *"review PR 11"*, *"why is the
  loop blocked?"*) — the skill's `description` routes these requests to it.

## What it does

1. Identifies intent and offers a clear menu (idea · GitHub issue · triage · watch ·
   explain status · review PR · recover blocked run · safe first-use).
2. Maps intent to the **exact, verified** agent-loop commands (it never invents flags or
   emits non-agent-loop commands).
3. Runs read-only commands freely; **asks for confirmation before anything that writes,
   executes, or spends provider tokens.**
4. Explains status and PRs in plain English, using the tool's own four-value verdict.

## Safety model (what it never does)

- No marking work complete (only the verifier decides).
- No bypassing the verifier, no skipping tests (there is no such flag — it won't invent one).
- **No auto-merge. No auto-deploy. No auto-closing issues.** Those capabilities don't exist
  in the tool and the skill won't script around them.
- No dangerous bypass flags without explicit, understood user opt-in.
- It never hides risks, and never presents the AI reviewer's opinion as stronger than the
  deterministic verifier. **The verifier remains the final authority. Human review is
  required before every merge.**
- It never tells the user a PR is "safe to merge" — only the verdict (e.g. `SAFE TO
  REVIEW`, which means *trustworthy to review*, not *merge blindly*).

## Confirmation rules

| Tier | Commands | Confirmation |
| --- | --- | --- |
| Read-only / safe | `status`, `inspect`, `logs`, `diff`, `watch --once`, `doctor`, `providers`, `github triage` (dry-run), `github import`, `github pr review` (no `--comment`) | None needed |
| Write / execute / spend | `run`, `run --auto`, `retry`, `github run-issue`, **any `--apply`**, posting PR comments, pushing branches, creating PRs, real-provider runs | **Always confirm first** |

## Verdict language

| Verdict | Meaning | Action |
| --- | --- | --- |
| 🟢 SAFE TO REVIEW | All automatic checks passed | Read report, do manual checks, **merge by hand** |
| 🟡 NEEDS HUMAN DEV REVIEW | Checks passed but signals to confirm | Ask a developer first |
| 🔴 DO NOT MERGE | Incomplete / failed checks / reviewer block | Do not merge |
| ⛔ BLOCKED | Hard safety rule stopped the work | Do not merge; developer needed |

## Validation

The skill is covered by a static test (`test/unit/claude-code-skill.test.ts`) that asserts
`SKILL.md` exists, contains the required safety phrases, and documents the key commands. A
manual + pressure-scenario validation report lives at
`reports/claude-code-skill-validation.md`. See also `docs/nontechnical-pr-review.md` for
the underlying plain-English PR review the skill surfaces.
