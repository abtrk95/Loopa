# Troubleshooting

Common failures, what they mean, and how to fix them. Start with `agent-loop doctor` —
it checks Node version, git, and provider health up front.

## "working tree has N uncommitted change(s)"

**Cause:** the engine refuses to start on a dirty tree by default. This is a safety
feature: rollback uses `git clean -fd`, which would delete your untracked files.

**Fix:** commit or stash your changes first. After `agent-loop init`, commit the created
`.gitignore` and your PRD/spec file. If you genuinely want to run on a dirty tree, set
`git.allowDirty: true` in config (or accept the loss of untracked files).
`.agent-loop/` itself is always excluded from this check.

## "no fake script for S-001" / demo or tests can't find provider script

**Cause:** the fake provider reads `.agent-loop/fake-provider.json`. If that file was
deleted (e.g. by a `git clean` that didn't exclude `.agent-loop/`), the fake provider has
nothing to do.

**Fix:** this is handled automatically now — the session adds `.agent-loop/` to
`.git/info/exclude` and rollback uses `git clean -fd -e .agent-loop`. If you hit it in a
custom script, ensure your fake-provider config lives under `.agent-loop/` and that your
own cleanup excludes that directory. Re-running `agent-loop init` recreates the layout.

## "agent produced no file changes" → slice fails

**Cause:** the worker exited cleanly but didn't modify any in-scope file. The empty-diff
guard fails the attempt (an agent claiming "done" without touching the repo gets nowhere
— by design).

**Fix:** check `.agent-loop/artifacts/context/<slice>__a<n>.md` (the exact prompt sent)
and the agent's captured output. Usually the slice scope or acceptance criteria are
ambiguous, or the real provider needs an autonomous-edit flag
(`providers.<id>.args`, see [provider-adapters.md](provider-adapters.md)). Tighten the
slice or grant the provider permission to edit files.

## Slice blocked: "changed files outside allowedPaths"

**Cause:** the agent edited a file the slice didn't declare. The verifier `fail`s
out-of-scope edits (and `block`s forbidden ones).

**Fix:** if the edit was legitimate, widen the slice's `allowedPaths` in `plan.json` and
`agent-loop retry`. If not, the verifier did its job — the agent was wandering; retrying
with a clearer prompt usually resolves it. See [verification.md](verification.md).

## Slice blocked: "potential secret in diff" / "git-internal" / "traversal"

**Cause:** a hard violation — a credential shape in the diff, a write under `.git/`, or a
`../` path escape. These are `block` (not auto-retried) on purpose.

**Fix:** remove the secret/offending change. If a "secret" is a false positive (a value
that merely looks like a key), move it out of the diff or restructure so the literal
isn't introduced. Then `agent-loop retry`.

## Slice blocked: "test weakening detected"

**Cause:** the diff disabled or hollowed out tests (`.skip`, `.only`, removed assertions).

**Fix:** the agent took the "delete the test to make it pass" shortcut. Restore the test
expectations and retry; if a test genuinely needs to change, make that change explicit and
narrow so it doesn't read as weakening.

## "diff too large: N > limit"

**Cause:** the slice's added lines exceeded `min(riskPolicy.maxDiffLines,
verification.maxDiffLines)` (default 800).

**Fix:** split the slice into smaller ones, or raise the limit if the size is justified.
Large diffs are usually a sign the slice was too coarse.

## Run ends BLOCKED with "unreachable: dependency blocked/failed"

**Cause:** a slice can't run because something it depends on is blocked/failed, so it was
cascade-blocked to reach a clean terminal state.

**Fix:** resolve the *root* blocked slice (its blocker report tells you why), then
`agent-loop retry` — the whole dependency chain re-opens.

## Agent process times out

**Cause:** the agent ran past `execution.agentTimeoutMs` (default 600000 ms). The manager
`SIGTERM`→`SIGKILL`s the whole process group and treats it as a retryable failure.

**Fix:** raise `agentTimeoutMs` for genuinely long tasks, or make slices smaller. Check
that the provider isn't waiting on an interactive prompt — real CLIs may need a
non-interactive/auto flag.

## "gh pr create failed" / branch not on remote

**Cause:** the branch isn't pushed, or `gh` isn't authenticated.

**Fix:** `agent-loop pr create --push` (pushes first), and ensure `gh auth status` is
green. agent-loop reuses an existing PR for the branch rather than duplicating.

## Parallel slice: "merge conflict during parallel integration"

**Cause:** two parallel slices touched overlapping content and the cherry-pick onto the
run branch conflicted; that slice was downgraded to `failed`.

**Fix:** the batch selector already serializes slices with overlapping `allowedPaths`, so
this means the overlap wasn't visible from scope alone. Narrow the scopes, lower
`execution.concurrency`, or retry — the conflicting sibling will have landed by then. See
[recovery.md](recovery.md#parallel-run-recovery).

## node:sqlite experimental warning

**Cause:** Node prints an `ExperimentalWarning` for `node:sqlite`.

**Fix:** already suppressed — agent-loop patches only that one specific warning
(`src/events/store.ts`) and runs node with `--no-warnings=ExperimentalWarning` in its
scripts. If you invoke the dist binary directly you may see it once; it's harmless. (It
goes away entirely when `node:sqlite` stabilizes.)

## "node >= 22.5" doctor failure

**Cause:** agent-loop relies on the built-in `node:sqlite`, which requires Node 22.5+.

**Fix:** upgrade Node (e.g. `nvm install 22 && nvm use 22`).

## Getting more detail

- Set `AGENT_LOOP_DEBUG=1` to print stack traces on unexpected errors.
- Read the raw log: `.agent-loop/events/events.jsonl`.
- `agent-loop inspect [<run-id>]` explains the current state from evidence.
- Check `.agent-loop/artifacts/` — `context/` (prompts), `checks/` (check output),
  `reviews/` (reviewer output) — for exactly what happened on each attempt.
