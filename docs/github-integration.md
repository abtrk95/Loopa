# GitHub integration

agent-loop's GitHub integration is deliberately minimal and **explicit**. It does one
outward thing — open a pull request — and only when you ask. It never pushes implicitly,
never merges, and never deploys.

Source: `src/github/pr.ts`, `src/cli/commands/pr.ts`, config `github.*`.

## Reading issues as input

On the **input** side, a GitHub issue is just another intake format. You can plan from
one:

```bash
agent-loop plan --issue 123        # fetches the issue (via gh) and normalizes it
```

The issue body is normalized like any PRD: the title becomes the objective, and checkbox
lines (`- [ ] ...` / `- [x] ...`) become acceptance criteria. See
[architecture.md](architecture.md#intake-srcintake).

## Creating a pull request

On the **output** side, the only command that talks to GitHub is:

```bash
agent-loop pr create [--push]
```

What it does (`createPullRequest`):

1. **Dedupe first.** `gh pr list --head <branch>` — if a PR already exists for the run
   branch, it returns that URL and does nothing else (`created: false`). No duplicate
   PRs.
2. **Push only if asked.** With `--push`, it runs `git push -u <remote> <branch>`. Without
   it, it assumes the branch is already pushed (and `gh` will tell you if it isn't).
3. **Create a draft PR.** `gh pr create` with a generated title and body, `--draft` when
   `github.draftPr` is true (the default), and `--base` when a base branch is configured.

The PR **title** is `agent-loop: <goal>`. The PR **body** is generated from the verified
snapshot and states the truth plainly:

```
## Summary
Autonomous implementation by agent-loop.

**Verified progress:** 3/3 slices (100%)
**Run state:** COMPLETED

## Slices
- S-001 ... — COMPLETED (aa1e0280)
- S-002 ... — COMPLETED (1c0fde21)
- S-003 ... — COMPLETED (33b9a07e)

> Completion is derived from deterministic verification + scoped commits, not agent claims.
> Review before merging. agent-loop does not auto-merge or deploy.
```

Note that the body reports **verified** progress (`verifiedCompleted/totalSlices`) and
each slice's real commit sha — the same evidence-based numbers as the dashboard, carried
into code review.

A `PR_CREATED` event (`{ url, created }`) records the action in the log.

## What agent-loop never does

- **Never auto-merges.** PRs are draft by default and merging is always a human action.
- **Never deploys.** There is no deploy path in the tool.
- **Never pushes without `--push`.** Pushing is an explicit flag on an explicit command.
- **Never opens duplicate PRs.** It reuses an existing PR for the branch.

This is part of the security posture: outward, hard-to-reverse actions require explicit
human intent. See [security-model.md](security-model.md#defense-7--explicit-outward-actions-only).

## Configuration

```yaml
github:
  enabled: false      # gate the feature
  remote: origin      # which remote to push to
  draftPr: true       # open as draft (recommended)
```

## Requirements

- The [`gh`](https://cli.github.com/) CLI installed and authenticated (`gh auth status`).
- A remote configured for the repo.
- If `gh pr create` fails because the branch isn't on the remote, re-run with `--push`.

`agent-loop doctor` reports whether `gh` is available so you can catch this before a run.
