# GitHub integration

agent-loop's GitHub integration is deliberately **explicit** and safe. The core outward
action is opening a **draft** pull request, only when you ask. It never pushes implicitly,
never merges, and never deploys.

This page documents the **PR** surface (and the input side of reading an issue). For the
**triage + Kanban orchestration** layer — issue classification, configurable labels,
GitHub Project (v2) sync, importing/running an issue, and watch mode — see
[github-triage-kanban.md](github-triage-kanban.md).

Source: `src/github/pr.ts`, `src/cli/commands/pr.ts`, `src/cli/commands/github.ts`,
`src/github/{client,triage,labels,project,watch}.ts`, config `github.*`.

## Reading issues as input

On the **input** side, a GitHub issue is just another intake format. You can plan from
one:

```bash
agent-loop plan --issue 123        # fetches the issue (via gh) and normalizes it
```

The issue body is normalized like any PRD: the title becomes the objective, and checkbox
lines (`- [ ] ...` / `- [x] ...`) become acceptance criteria. See
[architecture.md](architecture.md#intake-srcintake).

You can also import an issue from a **named repo** and (optionally) clarify it with the
interview before slicing, then run it through the local loop:

```bash
agent-loop github import    --repo owner/name --issue 123 [--interview]
agent-loop github run-issue --repo owner/name --issue 123 --auto [--pr] [--project]
```

See [github-triage-kanban.md](github-triage-kanban.md) for triage, labels, and Kanban.

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
- **Never opens duplicate PRs.** It reuses (and refreshes) an existing PR for the branch.
- **Never closes issues.** There is no `gh issue close` path; a PR links the issue with
  `Refs #N` (not `Closes`), so merging never auto-closes it.

This is part of the security posture: outward, hard-to-reverse actions require explicit
human intent. See [security-model.md](security-model.md#defense-7--explicit-outward-actions-only).

## Tests

**Hermetic (always on).** `test/integration/github-pr.test.ts` runs the full PR + issue
surface against a `gh` stub on `PATH` (and a real local bare remote for the push path) and
asserts: duplicate-PR prevention, draft-by-default + `--no-draft`, push **only** with
`--push`, read-only issue import, and — crucially — that **no `gh pr merge` / merge /
deploy verb is ever invoked** and the github module contains no such construction. This is
the machine-checked proof of "no auto-merge / auto-deploy path".

**Optional live test (opt-in, against a throwaway repo).** Gated on env so it never runs
by default or in CI:

```bash
# Read-only: confirms gh auth + access to the throwaway repo, mutates nothing.
AGENT_LOOP_GH_LIVE=1 AGENT_LOOP_GH_LIVE_REPO=your-org/throwaway-repo npm test -- github-pr
```

The live test only does `gh auth status` + `gh repo view` (read-only). Opening an actual
draft PR against a throwaway repo remains a deliberate manual step — do it by hand with
`agent-loop pr create` on a branch you don't mind, then delete the PR. There is, by
design, no automated path that could merge or deploy it.

## Configuration

```yaml
github:
  enabled: false      # gate the feature
  remote: origin      # which remote to push to
  draftPr: true       # open as draft (recommended)
  repo: ""            # default owner/name when --repo is omitted (optional)
  labels:             # configurable; safe agent-loop:* defaults shown elsewhere
    ready: "agent-loop:ready"
    needsInfo: "agent-loop:needs-info"
    # … planning, planReady, running, blocked, review, done, error,
    #    tooRisky, unsupported, plan, work, fix
  triage:
    triggerLabels: []           # empty → [ready, plan, work]; only these issues are considered
    commentClarifications: false
    interviewMode: quick        # depth of clarification questions
  project:
    enabled: false              # GitHub Project (v2) Kanban sync
    # number: 7                 # auto-detected if omitted
    statusField: Status
  watch:
    intervalSeconds: 300
    maxIterations: 0            # 0 = unbounded (requires explicit --yes to actually loop)
```

The triage/labels/Kanban/watch keys are documented in
[github-triage-kanban.md](github-triage-kanban.md).

## Requirements

- The [`gh`](https://cli.github.com/) CLI installed and authenticated (`gh auth status`).
- A remote configured for the repo.
- If `gh pr create` fails because the branch isn't on the remote, re-run with `--push`.

Check `gh` yourself with `gh auth status` before opening a PR. (`agent-loop doctor` checks
the Node/SQLite/git environment and configured AI providers; it does **not** probe `gh`.)
