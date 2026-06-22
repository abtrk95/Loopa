# Configuration

Configuration is validated by a versioned zod schema (`src/config/config.ts`) and loaded
through a layered resolver (`src/config/load.ts`). **Zero-config is valid**: with no
config file at all, agent-loop uses the deterministic `fake` provider, so `demo` and the
tests run with no credentials.

## Where config comes from (precedence, low → high)

```
built-in defaults  →  user config  →  project config  →  env vars  →  CLI flags
```

- **built-in defaults** — `defaultConfig()` (every key has a default).
- **user config** — `~/.config/agent-loop/config.yml` (skippable in tests).
- **project config** — `.agent-loop/config.yml` in the target repo (created by `init`).
- **env vars** — `AGENT_LOOP_*` overrides (see below).
- **CLI flags** — e.g. `--worker`, `--reviewer`, `--concurrency`, `--retries`, `--auto`.

Later layers deep-merge over earlier ones. The resolved config and the list of sources
are exposed on the session (`agent-loop inspect` and `doctor` surface them).

## The config file

`agent-loop init` writes a fully-commented `.agent-loop/config.yml`. All fields are
optional; the defaults shown below are what you get with an empty file.

```yaml
version: 1
auto: false            # run unattended: conservative assumptions, never prompt

roles:
  planner:
    provider: fake     # e.g. claude, codex, opencode
    # model: "<model-id>"
  workers:
    - provider: fake
      weight: 1
  # reviewer:          # optional single reviewer; enables the advisory review pass
  #   provider: claude
  #   model: "<model-id>"
  # reviewers:         # optional PANEL of DISTINCT reviewers for cross-model consensus
  #   - { provider: claude, model: "<model-id>" }
  #   - { provider: codex }
  #   - { provider: opencode }
  fixer:
    strategy: same-as-worker   # or a full provider ref
  # judge:                     # RESERVED — accepted but not yet wired (no effect)

routing:
  workerStrategy: round-robin  # static | round-robin | weighted | capability
  fallbackOrder: []            # providers to try when a provider fails (implemented)
  switchProviderOnRetry: false # advance the worker pool on each retry (implemented)
  reviewerConsensus: 1         # N reviews of the single `reviewer` (all must pass).
                               # Ignored when roles.reviewers (a distinct panel) is set.

execution:
  concurrency: 1               # parallel slices (via worktrees)
  maxRetriesPerSlice: 2
  retryBackoffMs: 2000
  retryJitterMs: 500
  agentTimeoutMs: 600000       # per agent process
  checkTimeoutMs: 300000       # per verification command
  budgetUsd: 0                 # 0 = unlimited; else stop run when exceeded
  budgetTokens: 0
  maxOutputBytes: 2000000      # per-process captured output cap

git:
  branchPrefix: "agent-loop/"
  requireCleanTree: true       # refuse to start on a dirty tree...
  allowDirty: false            # ...unless this explicit override is set

verification:
  commands: []                 # global checks; auto-detected from your project if empty
  allowedCommands: []          # if non-empty, only these argv[0]s may run as checks
  deniedCommands: []           # these argv[0]s are blocked (hard 'block')
  maxDiffLines: 800
  detectTestWeakening: true
  detectSecrets: true
  flagBinary: true

browser:                       # UI/browser verification (advisory; off by default)
  enabled: false               # master switch
  # startCommand: "npm run start"   # command that boots the app under test
  baseUrl: "http://127.0.0.1:3000"
  # readyPath: "/"             # probed for readiness (defaults to first route)
  routes: ["/"]                # paths to navigate + capture
  startupTimeoutMs: 30000
  navigationTimeoutMs: 15000
  failOnConsoleError: true     # a captured console/page error fails the route
  required: false              # true → a browser failure BLOCKS the slice
  engine: auto                 # auto (CDP/Chrome if found, else http) | cdp | http
  # chromePath: "/path/to/chrome"   # for real screenshots + console capture via CDP

riskPolicy:                    # plan-level safety (see schemas.ts: RiskPolicySchema)
  # globalForbiddenPaths, maxDiffLines, allowLockfileChanges, requireReviewAtOrAbove, ...

tui:
  color: true
  refreshMs: 1000
  compactWidth: 90             # switch to 2-column layout below this width

github:
  enabled: false
  remote: origin
  draftPr: true
  # repo: owner/name           # default when --repo is omitted (triage/import/run-issue)
  # labels: { ready: "agent-loop:ready", needsInfo: "agent-loop:needs-info", … }
  # triage: { triggerLabels: [], commentClarifications: false, interviewMode: quick }
  # project: { enabled: false, statusField: Status }   # GitHub Project (v2) Kanban
  # watch: { intervalSeconds: 300, maxIterations: 0 }

logging:
  level: info                  # debug | info | warn | error
  retentionDays: 30

providers:                     # per-provider overrides (binary, model, extra args)
  # claude:
  #   args: ["--permission-mode", "acceptEdits"]
  # codex:
  #   args: ["--full-auto"]
```

The schema is `.strict()` at every level — an unknown or misspelled key is a load-time
error, not a silently-ignored typo.

## Key reference

### `roles`
Maps each role to a provider reference `{ provider, model?, weight, options }`.
`workers` is a non-empty array (the pool the router draws from). `fixer` is either
`{ strategy: same-as-worker }` or a full provider ref. `reviewer` is optional —
omitting it (and `reviewers`) disables the advisory review pass entirely.

**Reviewer consensus.** Two modes:
- `reviewer` + `routing.reviewerConsensus: N` → run the *same* reviewer N times; all
  must pass (a single `blocked` is decisive).
- `reviewers: [...]` (a panel) → run each **distinct** provider/model once
  (cross-model consensus). The panel takes precedence over `reviewer` +
  `reviewerConsensus`. In both modes a reviewer can only request a fixer pass or
  block — it can **never** override the deterministic verifier.

> **Reserved role.** `judge` is accepted by the schema but is **not yet wired** into
> the orchestrator (it is never invoked; setting it has no runtime effect today).
> Browser/UI verification IS implemented and wired — but it is configured under the
> top-level `browser` section, not `roles.browser` (which remains reserved for a
> future provider-driven browser). See the Status section in the README.

### `routing`
Controls worker selection strategy, provider fallbacks, retry-switching, and reviewer
consensus count. See [provider-adapters.md](provider-adapters.md#routing).

### `browser`
UI/browser verification (off by default). When `enabled`, after a slice passes the
deterministic verifier the harness starts the app (`startCommand`), waits for
`baseUrl` to serve, navigates each `route` capturing a screenshot + console errors,
writes artifacts to `.agent-loop/artifacts/ui-smoke/`, and always tears the server
down. With a Chrome/Chromium binary present (`engine: auto|cdp`) it captures **real
PNG screenshots and real browser console errors** over the DevTools Protocol;
otherwise (`engine: http`) it performs real HTTP navigation, saving HTML snapshots
and flagging errors from HTTP status + an error sentinel. It is **advisory** unless
`required: true`, and can never override the deterministic verifier (it runs only
after a verifier pass). See [verification.md](verification.md#ui--browser-verification).
Note: browser verification assumes a single fixed `baseUrl`, so use `concurrency: 1`
(or per-slice ports) when enabling it alongside parallel slices.

### `execution`
Concurrency, retry budget and backoff (deterministic: `backoff = base * 2^(attempt-1)`
plus bounded jitter), per-process and per-check timeouts, optional cost/token budgets
(0 = unlimited), and the captured-output cap. `maxRetriesPerSlice: 2` means up to 3
attempts total (1 worker + 2 fixer).

### `git`
`branchPrefix` is prepended to a slug derived from the goal to form the run branch.
`requireCleanTree` (default true) makes the engine refuse to start on a dirty tree —
because rollback uses `git clean`, which would otherwise delete your untracked files.
`allowDirty` is the explicit, noisy override. (`.agent-loop/` itself is always excluded
from the cleanliness check.)

### `verification`
The deterministic verifier's policy knobs. `commands` are the global checks; if empty,
intake auto-detects them from your project (e.g. `npm test`, `npm run build`,
`tsc --noEmit`). `allowedCommands`/`deniedCommands` constrain which executables a check
may invoke. The detectors and size limit are described in [verification.md](verification.md).

### `riskPolicy`
Plan-level safety overrides that the verifier and executor consult:
`globalForbiddenPaths` (always-blocked globs), `maxDiffLines` (combined with the
verification limit via `min`), `allowLockfileChanges`, and `requireReviewAtOrAbove`
(the risk level at and above which the advisory review is mandatory rather than
advisory).

### `tui`, `github`, `logging`, `providers`
Dashboard appearance ([terminal-dashboard.md](terminal-dashboard.md)); GitHub PR
behavior ([github-integration.md](github-integration.md)); log level/retention; and
per-provider binary/model/arg overrides.

The `github` block also configures the **triage + Kanban** layer: `repo` (default
`owner/name`), `labels` (configurable `agent-loop:*` status + role/stage labels), `triage`
(trigger labels, clarification comments, interview depth), `project` (GitHub Project v2
Kanban sync), and `watch` (poll interval, max iterations). Full reference:
[github-triage-kanban.md](github-triage-kanban.md).

### Interview / intake
`plan --interview [quick|standard|strict]` and the `interview` command clarify the
objective before slicing. The interview improves planning only and can only *strengthen*
safety (it never weakens the verifier). It honors top-level `auto` (non-interactive →
conservative recorded assumptions) and reads `verification.commands` / `riskPolicy` as
context. See [interview-intake.md](interview-intake.md).

The interview can also **set the `roles` / `routing` / `execution.concurrency` /
`browser` / `github` keys above** from its agent/model orchestration questions: every
question carries a recommendation, `--accept-recommended` takes them all, and
`--write-config` merges the chosen override into this file (otherwise it applies to the
current run only). It is strengthen-only — e.g. it never sets `auto: true` on a high-risk
objective. See [interview-recommendations.md](interview-recommendations.md).

## Environment overrides

`AGENT_LOOP_*` variables override the matching config keys (resolved in `load.ts`'s
`envOverrides`). Useful in CI to flip `auto`, set a provider, or point at a model without
editing the file. Secrets should stay in provider-managed env (e.g. `ANTHROPIC_API_KEY`)
— agent-loop reads those only to build the redactor, never to persist them.

## CLI overrides

Flags on `plan`/`run` win over everything else for that invocation:

```bash
agent-loop run --auto \
  --worker claude:claude-sonnet-4-6 --worker codex \
  --reviewer claude --concurrency 2 --retries 3
```

`--worker` is repeatable (builds the worker pool). `provider:model` syntax sets the
model inline. See `cliConfigOverrides` in `src/cli/args.ts` for the full mapping.
