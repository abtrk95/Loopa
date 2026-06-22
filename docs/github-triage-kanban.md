# GitHub triage + Kanban automation

agent-loop can read issues from GitHub, **triage** them, optionally run the ready ones
through the *same local deterministic loop*, and reflect progress back as labels, a draft
PR, and a GitHub Project (Kanban) column.

> **The local verifier stays authoritative.** GitHub is an input/output surface, never
> the source of truth. There is **no auto-merge, no auto-deploy, and no issue-close**
> path. Triage, watch, and project sync default to **dry-run**; every external write is
> logged.

Pipeline:

```
GitHub issue / label / project card
  ↓  agent-loop github triage      (classify; never starts work)
  ↓  agent-loop github import       (issue → normalized plan)
  ↓  (interview if details missing) (clarify instead of weak slices)
  ↓  local deterministic loop runs  (verifier authoritative)
  ↓  verified, scoped commits
  ↓  optional draft PR (created/updated, linked to the issue)
  ↓  issue labels + project status updated
```

Source: `src/github/{client,triage,labels,project,watch,pr}.ts`,
`src/cli/commands/github.ts`.

## Commands

```bash
# Triage (classify issues). Dry-run by default; --apply to write.
agent-loop github triage --repo owner/name                 # dry-run preview
agent-loop github triage --repo owner/name --apply         # apply labels
agent-loop github triage --repo owner/name --apply --comment   # + clarification comments
agent-loop github triage --repo owner/name --issue 123     # a single issue
agent-loop github triage --repo owner/name --all           # include untagged issues

# Import an issue into a plan (no run).
agent-loop github import --repo owner/name --issue 123 [--interview [mode]]

# Plan + run an issue through the local loop, then update labels/board/(PR).
agent-loop github run-issue --repo owner/name --issue 123 --auto [--apply] [--pr] [--project]

# Watch: one safe pass, or bounded polling.
agent-loop github watch --repo owner/name --once               # one dry-run pass
agent-loop github watch --repo owner/name --once --apply       # one pass, writing labels
agent-loop github watch --repo owner/name --interval 300 --max-iterations 10   # bounded polling

# Project (Kanban) board.
agent-loop github project --repo owner/name                    # detect a board
agent-loop github project sync --repo owner/name --issue 123 --status Ready

# Draft PRs (explicit; reuse/refresh instead of duplicating).
agent-loop github pr create --repo owner/name [--issue 123] [--push] [--no-draft]
agent-loop github pr update --repo owner/name [--issue 123]
```

`--repo` may be omitted if you set `github.repo` in `.agent-loop/config.yml`.

## Dry-run vs apply

- **Triage, watch, project sync** default to **dry-run**: classifications and intended
  writes are printed/logged, but no `gh` write runs. Add `--apply` to write. An explicit
  `--dry-run` always wins.
- **`pr create` / `pr update`** are explicit human actions (like the top-level
  `agent-loop pr create`), so they apply by default; pass `--dry-run` to preview.
- Every write is announced on stderr: `[gh DRY-RUN] add-labels: #12 += [...]` /
  `[gh apply] …`.

## Triage classification

Each issue is classified deterministically:

| Status | Meaning | What triage does |
| --- | --- | --- |
| `ready` | actionable + specified (has acceptance criteria, or a detailed body) and not high-risk-without-criteria | label `agent-loop:ready` |
| `needs-info` | actionable but too thin to plan | label `agent-loop:needs-info`; optionally **comment clarification questions** (from the interview catalog) |
| `too-risky` | high-risk (auth/payment/migration/production/…) with no acceptance criteria — needs a human | label `agent-loop:too-risky` |
| `unsupported` | a question/discussion, not a change request | label `agent-loop:unsupported` |

Triage **never starts work**. Unclear issues get *clarification questions*, not weak
slices. By default only issues bearing a configured **trigger label** are considered
(`--all` to include everything; a single `--issue N` is always considered).

## Labels

Configurable, with safe `agent-loop:*` defaults (`.agent-loop/config.yml` →
`github.labels`):

| Key | Default | Used for |
| --- | --- | --- |
| `ready` | `agent-loop:ready` | triage ready / trigger |
| `needsInfo` | `agent-loop:needs-info` | triage needs-info |
| `tooRisky` | `agent-loop:too-risky` | triage too-risky |
| `unsupported` | `agent-loop:unsupported` | triage unsupported |
| `planning` / `planReady` | `agent-loop:planning` / `agent-loop:plan-ready` | run lifecycle |
| `running` | `agent-loop:running` | run executing |
| `blocked` | `agent-loop:blocked` | run blocked |
| `review` | `agent-loop:review` | awaiting review |
| `done` | `agent-loop:done` | run completed |
| `error` | `agent-loop:error` | run failed/cancelled |
| `plan` / `work` / `fix` | `agent-loop:plan` / `agent-loop:work` / `agent-loop:fix` | role/stage labels (Looper-style) |

Labels are an **observability projection** of the local run state, never the source of
truth. `run-issue` adds `running` while executing and `done`/`blocked`/`error` at the end
(removing the stale status label).

## GitHub Project (Kanban) sync

If a GitHub Project (v2) is linked to the repo and has a single-select status field
(default name `Status`), agent-loop can move an issue's card between columns. Suggested
columns:

```
Inbox · Needs Info · Ready · Planning · Running · Blocked · Review · Done
```

It is **best-effort and honest about limits**:

- It auto-detects the board (or use `github.project.number`).
- It maps triage status and run state to a column.
- If there is **no board**, the field/option/card is missing, or `gh` lacks project
  scope, it **records a warning and continues** with labels/PRs — it never fails the run.

**Requirements / limitations:** `gh auth refresh -s project` for project scope; the
status field must be a single-select named per `github.project.statusField`; column names
should match the suggested statuses. Enable with `github.project.enabled: true` (explicit
`github project …` commands enable it for that invocation).

## Watch mode (safe by design)

Start with a single pass:

```bash
agent-loop github watch --repo owner/name --once            # dry-run
```

Then, if you want polling, it is **bounded and opt-in**:

```bash
agent-loop github watch --repo owner/name --interval 300 --max-iterations 12
```

Safety properties:

- **dry-run default** (add `--apply` to write).
- **Lock file** (`.agent-loop/control/github-watch.pid`) prevents two watchers on one
  project; a stale lock from a crashed watcher self-heals.
- **Idempotent**: per-issue state (`.agent-loop/github/watch-state.json`) means an
  unchanged classification is skipped — repeated passes do no duplicate writes.
- **Bounded**: `--max-iterations` caps the loop; an unbounded loop requires an explicit
  `--yes`. `SIGINT`/`SIGTERM` stop it cleanly between passes.
- **Events**: each pass appends to `.agent-loop/github/watch-events.jsonl`.
- **Never** auto-merges, deploys, or closes issues.

## PR behavior

- **Draft by default** (`--no-draft` to override; `github.draftPr`).
- **No push** unless `--push`; **no merge**; **no deploy**.
- **Upsert, not duplicate**: `pr update` (and `run-issue --pr`) edit the existing PR for
  the branch, or create one if none exists.
- The body reports **verified** progress, the slice list with commit shas, the checks
  run, any blockers, and links the source issue with `Refs #N` (a reference — **not**
  `Closes`, so merging never auto-closes the issue).

## Safety summary

- No `gh pr merge`, no deploy verb, no `gh issue close` exists anywhere in the github
  modules (asserted by tests).
- All writes support dry-run and are logged.
- GitHub automation cannot bypass plan review, the verifier, scoped commits, or safety
  policy — `run-issue` runs the identical local engine under the single-writer run lock.

## Tests

- `test/integration/github-triage.test.ts` — hermetic `gh` stub: classification,
  dry-run (no writes) vs apply (labels + comments), trigger-label filtering, project
  detect / move / graceful fallback, PR upsert/dedupe, idempotent `watch --once`,
  polling max-iterations, duplicate-watcher prevention, and **no merge/deploy/close**
  verb or construction.
- `test/integration/github-e2e.test.ts` — the full combined chain through the real
  `github run-issue` command (triage → import → interview → plan → run fake provider →
  verify → commit → draft PR → labels + project → report), end to end, hermetic.

## Optional live check (opt-in)

Live GitHub is never required for tests. A read-only live check is gated on env (see
[github-integration.md](github-integration.md)):

```bash
AGENT_LOOP_GH_LIVE=1 AGENT_LOOP_GH_LIVE_REPO=your-org/throwaway npm test -- github-pr
```

For a live triage **dry-run** against a throwaway repo:

```bash
agent-loop github triage --repo your-org/throwaway   # dry-run; reads only
```
