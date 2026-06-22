# agent-loop — Claude Code skill

A **safe operator assistant** for the [`agent-loop`](../../../README.md) CLI. It lets a
non-technical user drive agent-loop conversationally — *"add ticket search"*, *"run issue
123"*, *"is PR 11 safe?"* — without memorizing commands, and without ever doing something
unsafe.

The skill is an **operator layer on top of the existing CLI**, not a replacement for it
and not an authority over it. The deterministic verifier stays the sole completion
authority; a human always merges.

## Files

| File | Purpose |
| --- | --- |
| `SKILL.md` | The skill itself (loaded by Claude Code). Safety contract, confirmation rules, the verified command surface, intent→command mapping, plain-English verdict language. |
| `README.md` | This file — purpose, how to invoke, limitations. |
| `examples/start-from-idea.md` | Worked conversation: idea → plan → run. |
| `examples/github-issue-flow.md` | Worked conversation: triage → import → run-issue → PR. |
| `examples/review-pr.md` | Worked conversation: plain-English PR review. |
| `examples/progress.md` | Worked conversation: status / progress / recovery. |

## How to invoke

In Claude Code, project skills live under `.claude/skills/<name>/SKILL.md` and are
discovered automatically. Trigger it by:

- typing `/agent-loop`, or
- speaking naturally — *"start a loop for issue 123"*, *"triage my repo"*, *"check
  progress"*, *"review PR 11"*, *"why is the loop blocked?"* — the skill's description
  routes these to it.

The skill then guides you, runs read-only commands freely, and **asks for confirmation
before anything that writes, executes, or spends provider tokens.**

## What it will and won't do

**Will:** explain status and PRs in plain English; map intent to the *exact, verified*
agent-loop commands; default to dry-run/draft/concurrency-1; surface every risk; recommend
a developer when a verdict isn't `SAFE TO REVIEW`.

**Won't (ever):** mark work complete, bypass the verifier, skip tests, auto-merge,
auto-deploy, close issues, use dangerous bypass flags, hide risks, present the AI
reviewer's opinion as stronger than the deterministic verifier, or tell you a PR is "safe
to merge." Human review is required before every merge.

## Limitations

- It guides; it does not merge, deploy, or close issues — those stay with you, by design.
- It reports objective evidence; it does not judge whether a feature is the right product
  decision.
- Real runs need a configured provider (Claude/Codex/opencode) and, for GitHub commands,
  an authenticated `gh`. Run `agent-loop doctor` to check.
- This skill was validated statically and against agent pressure-scenarios (see
  `reports/claude-code-skill-validation.md`); confirm the exact in-product invocation
  string for your Claude Code version.
