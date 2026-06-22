# Provider adapters

A **provider** is the thing that runs an AI agent for a role. In agent-loop a provider
is always a *worker*: its structured output (a summary, a blocker signal, a list of
files it thinks it changed) is **advisory only**. The orchestrator re-derives reality
from git and the deterministic verifier regardless of what the provider reports.

Source: `src/providers/types.ts` (contract), `src/providers/fake.ts`,
`src/providers/command.ts`, `src/providers/registry.ts`, `src/providers/routing.ts`.

## The contract

Every provider implements `ProviderAdapter`:

```ts
interface ProviderAdapter {
  readonly id: string;
  capabilities(): ProviderCapabilities;          // roles, structuredOutput, streaming
  detectVersion(): Promise<string | null>;        // CLI version, or null if absent
  health(): Promise<HealthStatus>;                // is the binary runnable?
  authStatus(): Promise<HealthStatus>;            // best-effort auth check
  execute(req: ProviderRequest): Promise<ProviderResult>;
}
```

`execute` receives a `ProviderRequest` containing the **fully-built, fresh context
pack** (the prompt), the working directory (the main worktree or a per-slice worktree),
an optional model, a timeout, a redactor, an abort signal, an output callback, and the
slice id/attempt. It returns a `ProviderResult`:

```ts
interface ProviderResult {
  ok: boolean;          // process exited cleanly — NOT a claim of correctness
  exitCode: number | null;
  stdout: string; stderr: string;
  structured?: StructuredResult;   // advisory: { summary?, blocker?, filesChanged? }
  blocker?: string;                // set when the agent says it cannot proceed
  costUsd?: number; tokens?: number;
  durationMs: number;
  truncated: boolean; timedOut: boolean; cancelled: boolean;
}
```

The `ok` field means "the process exited 0 and wasn't killed" — it is explicitly *not*
a statement that the work is correct. Correctness is decided downstream by the verifier
over git state.

### Roles

`planner | worker | reviewer | fixer` are active roles. `judge` and `browser` are
**reserved** — present in the schema but not yet invoked by the orchestrator. A provider
declares which roles it can serve via `capabilities().roles`. The router only assigns a
provider to a role it can serve (see capability routing below).

## Structured output: the result marker

An agent may optionally emit one line of structured JSON prefixed with the marker
`__AGENT_LOOP_RESULT__`:

```
__AGENT_LOOP_RESULT__ {"summary": "added /health route + test", "filesChanged": ["src/health.ts"]}
```

`parseStructuredResult` reads the **last** such line from stdout. This is purely for
nicer summaries and for an agent to *self-report a blocker* (`{"blocker": "missing DB
credentials"}`), which the executor honors by blocking the slice. It is never used to
decide completion — `filesChanged` is not trusted; the verifier uses the real diff.

## The fake provider (deterministic)

`FakeProvider` makes the entire system runnable and testable with **no credentials and
no network**. It reads a script from `.agent-loop/fake-provider.json`:

```json
{
  "slices": {
    "S-001": {
      "files": { "src/health.ts": "export const health = () => 200;\n" },
      "delete": ["old/legacy.ts"],
      "blocker": null,
      "attempts": { "1": { "blocker": "simulated transient failure" } }
    }
  },
  "reviews": { "S-001": { "verdict": "pass" } }
}
```

For a worker/fixer role it writes/deletes the scripted files in `cwd` and emits an
optional structured summary; it can simulate per-attempt blockers (to exercise the retry
path) or a hard blocker. For a reviewer/judge role it returns the scripted verdict. This
is what powers `agent-loop demo` and the entire test suite — so tests are hermetic and
free.

## The command provider (real CLIs)

`CommandProvider` is a generic adapter over any CLI agent. Built-in presets
(`presetSpec`) cover:

| id | binary | pack delivery | model flag | version |
| --- | --- | --- | --- | --- |
| `claude` | `claude` | stdin (`-p`) | `--model <m>` | `--version` |
| `codex` | `codex` | arg (`exec`) | `-m <m>` | `--version` |
| `opencode` | `opencode` | arg (`run`) | `-m <m>` | `--version` |

It builds `argv` from `baseArgs` + model args + extra args + (for `arg` delivery) the
context pack, then runs it through the sandboxed `ProcessManager`. Timeouts and spawn
failures surface as a non-`ok` result (so the engine applies its retry policy rather
than crashing). Structured output is parsed from stdout via the result marker.

### Safety: no danger flags by default

The presets are deliberately minimal. agent-loop **does not** add permission-bypass or
sandbox-escape flags. If your CLI needs a flag to edit files autonomously, you opt in
explicitly in config — and that choice is yours, recorded in `config.yml`:

```yaml
providers:
  claude:
    args: ["--permission-mode", "acceptEdits"]
  codex:
    args: ["--full-auto"]
```

See [security-model.md](security-model.md) for the rationale.

### Operational note: host agent-tooling that writes into the working directory

Some Claude Code installs run **session hooks** (e.g. the `claude-flow` add-on) that write
telemetry/scratch files into the **current working directory** every time the `claude`
binary runs — directories like `.claude-flow/`, `.swarm/`, `.hive-mind/`. When `claude` is
your worker, those writes land in your target repo's working tree and the deterministic
verifier **correctly** flags them as out-of-scope (`changed files outside allowedPaths`),
blocking the slice and refusing to commit. This is the scope policy working as designed —
not a bug — but it will stall real runs until you tell git to ignore that scratch. Exclude
it the same way agent-loop excludes its own `.agent-loop/` state:

```bash
printf '.claude-flow/\n.swarm/\n.hive-mind/\n' >> .git/info/exclude   # or add to .gitignore
```

git-ignored files don't appear in `git status --porcelain --untracked-files=all`, so the
verifier's changed-path set then contains only the agent's real edits. (Codex writes to
`~/.codex`, not the repo, so it isn't affected.) This was observed first-hand in
[../reports/live-real-provider-smoke.md](../reports/live-real-provider-smoke.md).

> **Cost capture caveat.** `claude -p` / `codex exec` emit human text, not a machine-parseable
> cost line, so `CommandProvider` records `costUsd:0 / tokens:0` even though real tokens are
> spent — `execution.budgetUsd`/`budgetTokens` therefore cannot enforce a ceiling for these
> text CLIs. Bound spend structurally instead (small tasks, `concurrency:1`, low
> `maxRetriesPerSlice`, `agentTimeoutMs`).

## Routing

The `Router` (`routing.ts`) maps roles → provider+model per slice/attempt, pure over
config plus an optional capability predicate:

- **planner** — taken from its configured role ref. (`judge` is reserved and not yet
  invoked.)
- **reviewer(s)** — either the single `roles.reviewer` (run `routing.reviewerConsensus`
  times for consensus), or `roles.reviewers` — a panel of **distinct** provider+model
  refs, each run once for cross-model consensus. The panel takes precedence. All votes
  must pass; one `blocked` is decisive. Reviewers are advisory and can never override the
  deterministic verifier.
- **worker** — chosen from `roles.workers` by `routing.workerStrategy`:
  - `static` — always the first capable worker.
  - `round-robin` — cycle through capable workers (default).
  - `weighted` — round-robin over a pool expanded by each worker's `weight`.
  - `capability` — a stable capable worker, advancing only on retry.
- **fixer** — `same-as-worker` by default (reuses the worker selection), or a distinct
  configured provider.
- **fallbacks** — `routing.fallbackOrder` lists providers to try, in order, when a
  provider fails to produce a result within an attempt. The executor fails over to the
  next capable, registered fallback transparently (a definitive blocker/cancel stops the
  chain).
- **switchProviderOnRetry** — when set, each retry re-selects the worker (advancing the
  pool/strategy) instead of reusing the same provider; otherwise retries use the fixer.

By default the executor chooses the worker once per slice (first attempt) and uses the
fixer for subsequent attempts; `switchProviderOnRetry` and `fallbackOrder` change this as
described above.

## Registry

`createRegistry(config, root, pm)` builds the set of live adapters from config: it always
includes `fake`, and instantiates a `CommandProvider` for any referenced provider id
(applying `providers.<id>` overrides for binary path, default model, and extra args).
The orchestration core only ever talks to the registry + router, never a concrete
provider class — which is exactly what makes adding a provider a config-only change for
preset CLIs, or a one-file change for a brand-new adapter.

## Adding a new provider

1. If it's a CLI similar to the presets, just reference it in config and add a
   `providers.<id>` block (binary, args). For a non-preset id you can supply a full spec
   via config overrides.
2. For a fundamentally different integration (e.g. an HTTP API), implement
   `ProviderAdapter` in a new file under `src/providers/`, register it in
   `registry.ts`, and declare its capabilities. Nothing in `orchestrator/`,
   `verify/`, or `events/` needs to change — the contract is the seam.

## Real-provider smoke tests

`test/integration/provider-smoke.test.ts` proves provider wiring at two levels.

**Hermetic (always on, no credentials).** An argv-recording stub stands in for each CLI
and asserts the *exact* command + model-flag construction and prompt-delivery convention
for every preset, plus that **no permission-bypass flags** are ever added by default:

| Provider | argv (for model `M`) | prompt delivery |
| --- | --- | --- |
| `claude` | `-p --model M` | stdin |
| `codex` | `exec -m M <pack>` | arg |
| `opencode` | `run -m M <pack>` | arg |

**Opt-in (real CLIs).** These run only when you set the matching env var, and only do
safe `--version`/health probes (no tokens spent). The CLI must be installed **and on the
`PATH` the test process inherits**:

```bash
AGENT_LOOP_SMOKE_CLAUDE=1   npm test -- provider-smoke   # claude --version + health
AGENT_LOOP_SMOKE_CODEX=1    npm test -- provider-smoke   # codex  --version + health
AGENT_LOOP_SMOKE_OPENCODE=1 npm test -- provider-smoke   # opencode --version + health
```

**Opt-in live coding smoke (SPENDS REAL TOKENS, double-gated).** Drives a real session
against a throwaway repo and asserts the provider was actually spawned and the run
terminated (success is not asserted — a real model may or may not satisfy the slice):

```bash
AGENT_LOOP_SMOKE_LIVE=1 AGENT_LOOP_SMOKE_LIVE_PROVIDER=claude npm test -- provider-smoke
```

Set `chromePath`/`AGENT_LOOP_CHROME` is unrelated to providers — that's for browser
verification (see [verification.md](verification.md)).
