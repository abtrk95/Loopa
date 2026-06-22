# Terminal dashboard

The dashboard is a **read-only** live view of a run. It derives everything from the event
store and live git, and the only thing it ever writes is a control-plane *request*
(pause/resume/stop) when you press a key — never run state directly. Because all
authoritative state lives in the durable store, you can attach from any terminal, detach,
and reconnect at will, even mid-run.

Source: `src/watch/render.ts` (rendering), `src/watch/dashboard.ts` (the watcher).

## Layout

```
┌ agent-loop watch ─────────────────────────────────────────────── COMPLETED ┐
│ Goal:   Build a tiny calculator module with add, subtract, and an index     │
│ Branch: agent-loop/build-a-tiny-calculator-module-with-add-                 │
│ Runtime: 00:00:00   Progress: 3 / 3 slices done                             │
│ [████████████████████████████] 100%                                         │
│ Progress is derived from runtime signals: git state, file changes, checks.  │
└─────────────────────────────────────────────────────────────────────────────┘

┌ CURRENT SLICE ──────────────┐ ┌ CHECKS ─────────┐ ┌ CHANGED FILES (1) ──────┐
│ S-003 Add the calculator in…│ │ test       ✓    │ │ 1 src/index.js          │
│ Phase:  completed           │ └─────────────────┘ └─────────────────────────┘
│ Worker: fake                │
│ Attempt: 1   Retries: 0     │
└─────────────────────────────┘

┌ RECENT EVENTS ──────────────────────┐ ┌ GIT ─────────────────────────────────┐
│ 11:28:01 SLICE_COMPLETED  S-003      │ │ clean working tree: yes              │
│ 11:28:01 FINAL_VERIFICATION_STARTED  │ │ uncommitted files:  0               │
│ 11:28:01 CHECK_STARTED  npm run test │ │ last commit: aa1e0280 S-003 Add …   │
│ 11:28:01 RUN_COMPLETED               │ │ cost: $0.0000 / 300 tok             │
└──────────────────────────────────────┘ └──────────────────────────────────────┘

[p] pause   [r] resume   [l] logs   [g] diff   [q] quit
```

### Panels

- **Header** — goal, run branch, runtime, the verified progress bar
  (`verifiedCompleted / totalSlices`), and the run state in the top-right (color-coded).
  The footer line is the standing reminder that progress comes from runtime signals, not
  agent claims.
- **CURRENT SLICE** — the active slice id/title, its phase (mapped from slice state:
  `working`, `verifying`, `reviewing`, `fixing`, `committing`, `retry pending`,
  `blocked`, …), the worker provider, and attempt/retry counters.
- **CHECKS** — each verification check with a live state glyph (running / `✓` passed /
  `✗` failed).
- **CHANGED FILES** — the real changed-file set from the latest `FILE_CHANGED` event.
- **RECENT EVENTS** — the last ~14 events, timestamped and color-coded by type.
- **GIT** — live working-tree cleanliness, uncommitted count, last commit, and accrued
  cost/tokens.
- **Footer** — the available keys.

### Responsive layout

The renderer adapts to terminal width: a 3-column middle row on wide terminals, folding
to 2 columns below `tui.compactWidth` (default 90), with the footer wrapping as needed.
Box widths are computed against the actual column count so content never overflows the
frame.

## Modes

`agent-loop watch` (and `run --watch`) support several output modes:

| Mode | Flag | Behavior |
| --- | --- | --- |
| Live | (default, TTY) | Full-screen dashboard, refreshing every `intervalMs` (default 1000), with keyboard control. |
| Once | `--once` | Render a single frame and exit (great for scripts/CI). |
| Plain | `--plain` | Plain-text frame (no ANSI/boxes), also used automatically for non-TTY output. |
| JSON | `--json` | Emit `{ snapshot, git }` as JSON — one object (`--once`) or a stream (live). Machine-readable. |

Other flags: `--no-color`, `--compact` (force 2-column), `--interval <ms>`, `--no-git`
(skip live git calls), `--run <run-id>` (watch a specific run).

`run --watch` sets `exitWhenFinished`, so the live dashboard closes automatically when
the run reaches a terminal state, then prints the run result.

## Keyboard control (live mode)

| Key | Action |
| --- | --- |
| `p` | Request **pause** (writes intent to the control plane). |
| `r` | Request **resume**. |
| `l` | Open the **logs** modal (tail of the structured log). |
| `g` | Open the **git diff** modal (current working-tree diff, truncated). |
| any | In a modal, return to the dashboard. |
| `q` / `Ctrl-C` | Quit the watcher (does **not** stop the run). |

Pressing `p`/`r` only writes `.agent-loop/control/control.json`; the engine — the sole
owner of run state — reads that request at its next checkpoint and acts on it. Quitting
the watcher detaches cleanly and leaves the run untouched; you (or anyone) can re-attach
later. Raw-mode terminal state and the cursor are always restored on exit, including on
`SIGINT`.

## Why read-only matters

Keeping the watcher strictly read-only (intent-only via the control file) is what makes
attach/detach/reconnect safe and what preserves the single-writer guarantee on
authoritative state. The dashboard can crash, be killed, or run in five terminals at
once; none of that can corrupt a run, because none of it mutates the event log.

`test/integration/watch-secrets.test.ts` verifies that a JSON snapshot renders
consistently, that re-attaching yields the same state, that a plain-text frame renders
for non-TTY output, and that secrets are redacted in what the watcher reads back.

## Not to be confused with `github watch`

`agent-loop watch` is this read-only **run dashboard**. `agent-loop github watch` is a
separate, non-TUI **issue-triage polling loop** (dry-run by default, bounded, locked) —
it does not render the dashboard. See [github-triage-kanban.md](github-triage-kanban.md).
