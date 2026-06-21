# Security model

agent-loop runs untrusted AI agents that edit your code and execute commands. The
security model treats every agent as a potentially-careless or actively-wrong actor and
constrains the blast radius with deterministic, model-independent controls. This
document states the threat model and the defenses.

## Threat model

We defend against (in roughly decreasing likelihood):

1. **Accidental scope creep** — an agent edits files outside the slice's intent.
2. **Secret leakage** — credentials end up in a commit, a log, an event, or the screen.
3. **Self-sabotaging "success"** — an agent weakens or deletes tests to make checks pass.
4. **Repository corruption** — writes under `.git/`, path traversal, symlink escapes.
5. **Runaway processes** — agents that hang, fork children, or never terminate.
6. **Shell injection** — crafted filenames/arguments executing unintended commands.
7. **Unwanted outward actions** — pushing, opening PRs, merging, or deploying without
   explicit human intent.

We do **not** claim to sandbox a determined malicious binary (that requires OS-level
containment); we minimize the realistic harms of an autonomous coding agent on a
developer's machine.

## Defense 1 — scope policy (blast-radius containment)

Each slice declares `allowedPaths` (required, ≥1 glob) and may declare `forbiddenPaths`;
the plan declares `globalForbiddenPaths`. The deterministic verifier checks the **real**
changed-path set against these:

- a path outside `allowedPaths` → `fail` (recoverable; the agent can correct it),
- a path matching a forbidden glob → `block` (hard stop, not retried).

Commits are **scoped**: only verifier-confirmed in-scope files are staged. An agent
cannot smuggle an out-of-scope edit into a commit.

## Defense 2 — structural safety scan

`structuralScan` (`src/git/scope.ts`) inspects changed paths for repository-corrupting
shapes and blocks the dangerous ones:

| Finding | Severity |
| --- | --- |
| write under `.git/` (`git-internal`) | block |
| `../` path traversal | block |
| symlink pointing outside the repo (`symlink-escape`) | block |
| submodule change | fail |
| binary file | flag (configurable) |

## Defense 3 — secret handling (two independent layers)

**Layer A — block secrets from being committed.** If `verification.detectSecrets` is on,
the verifier scans the diff *including untracked content* for credential shapes; any hit
→ `block`. The secret never reaches a commit.

**Layer B — redact secrets from everything persisted or displayed.** The `Redactor`
(`src/security/redact.ts`) masks:

- **Pattern-based:** private-key blocks, OpenAI/Anthropic `sk-...`/`sk-ant-api...` keys,
  Stripe `sk_live_`/`rk_live_`/`pk_live_` keys, GitHub PATs (`ghp_`, `gh[osur]_`,
  `github_pat_`), GitLab PATs (`glpat-`), npm tokens (`npm_`), Slack tokens, AWS access
  key ids (`AKIA`/`ASIA`), Google API keys, `Bearer` tokens, and JWTs.
- **Literal-value:** the exact values of secret-bearing environment variables
  (collected by `src/security/env.ts`), masked wherever they appear — even partial
  overlaps — as long as they're non-trivial (≥6 chars).

Redaction is applied at **every** boundary: process stdout/stderr capture, streamed
output, event payloads, logs, error messages, blocker reports, run reports, context
packs (including inlined untrusted source), browser-verification artifacts, and dashboard
text — including the watcher's live git diff/last-commit view (the watcher's `GitRepo` is
constructed with the redactor). As defense in depth, the event store itself is
constructed with the redactor and redacts each payload **before** it is written to
SQLite — so even a caller that forgot to redact cannot persist a secret. The agent's own
streamed output is redacted before it becomes an `AGENT_PROCESS_OUTPUT` event.

`test/integration/artifact-security.test.ts` proves this end to end: after a run that
pushes a secret through the agent blocker and untrusted source, **every** file under
`.agent-loop/` (the SQLite db + WAL/SHM, the JSONL mirror, JSON/MD reports, the blocker
report, context packs, logs) and both TUI snapshots (`watch --json`/`--plain`) are
asserted to contain no secret.

## Defense 4 — anti-test-weakening

A favorite LLM shortcut is "make the failing test pass by removing the test." If
`verification.detectTestWeakening` is on, the verifier flags diffs that disable or hollow
out tests (`.skip`, `.only`, `xit`, commented-out assertions, etc.) → `fail`. Combined
with the empty-diff guard (no changes → `fail`), there is no cheap path to a green check.

## Defense 5 — process sandbox

`ProcessManager` (`src/process/manager.ts`) is the single choke point for every external
command:

- **No shell** — `spawn(..., { shell: false })` with an argv array; the tokenizer
  (`src/process/command.ts`) is quote-aware and never hands a string to a shell, so
  filenames/args can't inject commands.
- **Process groups + hard timeout** — children run detached in their own process group;
  on timeout the manager sends `SIGTERM`, then `SIGKILL` to the **whole group** (POSIX),
  so agents can't orphan background children. On Windows, which has no process groups,
  the tree is reaped with `taskkill /T` instead (documented best-effort; see
  [operations.md](operations.md)). Long-running servers (e.g. under browser verification)
  are managed by `spawnServer`, whose `stop()` reaps the tree the same way.
- **Bounded output** — captured output is capped (`maxOutputBytes`) to prevent memory
  exhaustion; the result is marked `truncated`.
- **Filtered environment + cancellation** — the child env is filtered, and an
  `AbortSignal` cancels cleanly (used by `stop`).
- **Single-writer run lock with stale-PID recovery** — `agent-loop run`/`retry` take a
  PID lock (`.agent-loop/control/run.pid`). A second live orchestrator is refused; a lock
  left by a hard-killed (`kill -9`) run is detected as stale (dead holder PID) and
  reclaimed, so a crash never permanently bricks the project. See
  [recovery.md](recovery.md).

## Defense 6 — no danger flags by default

Real provider CLIs often have a "just do it" flag (`--full-auto`,
`--permission-mode acceptEdits`, sandbox-bypass). agent-loop's presets add **none** of
these. If you want autonomous file editing you opt in explicitly via
`providers.<id>.args` in your config — a deliberate, auditable choice that lives in your
repo, not a hidden default. See [provider-adapters.md](provider-adapters.md).

## Defense 7 — explicit outward actions only

Nothing leaves your machine implicitly. agent-loop never pushes, opens a PR, merges, or
deploys on its own. Pushing and PR creation happen **only** when you run
`agent-loop pr create` (and pushing only with `--push`); PRs are **draft by default** and
agent-loop never merges. See [github-integration.md](github-integration.md).

## Defense 8 — protected working state

The engine refuses to start on a dirty tree by default (`git.requireCleanTree`), because
rollback uses `git clean -fd` and an unprotected untracked file would be destroyed. The
`.agent-loop/` directory is added to `.git/info/exclude` so run metadata never dirties
your tree and is always preserved by the `-e .agent-loop` guard on clean. Every attempt
starts from a clean tree, so an aborted attempt cannot leak partial files into a commit.

## Defense 9 — private artifacts (owner-only run state)

Run state can contain prompts, inlined source, and run metadata. Where the OS enforces
POSIX permissions, agent-loop creates the entire `.agent-loop/` tree **owner-only**
(directories `0700`) and writes its sensitive files (`events.db` + WAL/SHM, the JSONL
mirror, logs, context packs, reports, the control/PID files, run metadata) `0600`. This
keeps run state from being world-readable on a shared host (redaction already removes
secrets; this additionally walls off prompts/source/metadata). **Windows caveat:** POSIX
mode bits are not enforced there, so `chmod` is a documented no-op — rely on the user
profile's ACLs on Windows.

## Residual risks (be honest)

- A required check you configure *does* run arbitrary commands you specified — vet your
  `verification.commands`. The allow/deny lists exist to constrain this.
- Pattern-based secret detection is heuristic; novel credential formats may slip past
  Layer B's patterns (Layer A's literal-value masking still covers anything present in
  your environment).
- agent-loop is not an OS sandbox. Run real providers in an environment you're
  comfortable giving a coding agent (a container or VM for untrusted work).
