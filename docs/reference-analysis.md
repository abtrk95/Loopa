# Reference Analysis

This document records what was learned from the four reference projects in the
workspace, which concepts were **selected** for `agent-loop`, which were
**rejected**, and the **licensing constraints** that governed reuse.

> **Provenance policy.** `agent-loop` is a clean-room reimplementation. No
> substantial code was copied from any reference. Three references are MIT
> (reuse permitted with attribution); one (ui-loop) is unlicensed, so only its
> *ideas* were studied. See `THIRD_PARTY_NOTICES.md`.

---

## 1. Go Looper (`looper-main 2/`) — MIT, "looper contributors"

A local, polling daemon that runs specialized AI roles (Planner, Reviewer, Fixer,
Worker, Coordinator) against GitHub repositories, using GitHub state as the source
of truth, isolated git worktrees, and SQLite event sourcing.

**Useful concepts found**
- Role-specialized loops rather than one monolithic agent.
- Each loop runs in its own git **worktree** → safe concurrency by construction.
- **SQLite event log** as durable, append-only audit trail; all side effects emit an event.
- **Provider/vendor adapter** abstraction (`claude-code`, `opencode`, `cursor`, `codex`) behind one shelling interface.
- **Structured completion marker** (`__LOOPER_RESULT__={...}`) instead of regex-scraping prose.
- **Checkpoint-based resume** to avoid re-running long agent steps from zero.
- GitHub **labels as authority** and **comment markers** for stateless dedup.
- Bounded **retry queue** with backoff, separate from the run state machine.
- **Env filtering** (strip `GIT_DIR`, `GIT_WORK_TREE`, …) before spawning agents.

**Selected for `agent-loop`**
- Role-specialized providers (planner / worker / reviewer / fixer / judge) — §4 routing.
- Worktree-per-slice isolation for parallel execution — `src/git/worktree.ts`.
- SQLite (WAL) event store as the canonical, append-only store — `src/events/store.ts`.
- Provider adapter interface with structured result extraction — `src/providers/`.
- Env filtering + secret redaction before any subprocess — `src/security/`.
- Bounded retry with exponential backoff + jitter — `src/orchestrator/retry.ts`.
- GitHub issue import + draft-PR creation via `gh`, kept strictly optional — `src/github/`.

**Rejected / de-scoped**
- The networked multi-node coordinator (`loopernet`, leases, routed targets):
  unnecessary for a reliable local-first core (anti-goal: "complex distributed daemon
  before the local core is reliable").
- Schema churn (`loops_v2/v3/v4`) and 20+-column agent-execution telemetry:
  over-engineered; we model one well-designed schema with migrations.
- Webhook forwarder/tunnel bifurcation and the always-on daemon: `agent-loop` runs a
  bounded run to completion rather than polling forever.
- LLM-based issue triage: out of scope for the execution core.

---

## 2. Looper skill/design (`looper-main/`) — MIT, "Kevin Simback"

A Claude Code skill that interviews a user and scaffolds a portable loop spec
(`loop.yaml` → compiled `loop.resolved.json`). Pure scaffolding — it never runs the
loop itself.

**Useful concepts found**
- **Seven-stage intake wizard** with progressive disclosure of coaching rubrics.
- **Typed verification taxonomy:** `programmatic` (deterministic check), `judge`
  (model verdict), `human` (signoff). Each criterion is a first-class object.
- **Canonical schema split:** human-authored YAML source → compiled, validated,
  ref-resolved runtime JSON.
- **Explicit termination guards:** `max_iterations`, `max_revisions`,
  `max_stalled_iterations`, budget caps — a loop must name how it stops.
- **Cross-model council** (reviewer vs judge) with **privacy egress + redaction**
  defaults (`.env`, `secrets/**`, `**/*.key`) and consent gates.
- **Structured judge verdict** (`{verdict, blocking_issues, confidence, notes}`).
- Argv arrays (never shell strings) for all invocations.

**Selected for `agent-loop`**
- Typed verification taxonomy drives the canonical spec's `successCriteria` and each
  slice's `acceptanceCriteria` — `src/domain/schemas.ts`.
- Canonical spec is the compiled, validated source of truth (`plan.json`), authored
  from many input formats — `src/intake/`, `src/planner/`.
- Explicit termination guards become first-class config + plan fields (retry budgets,
  max attempts, iteration caps) — `src/config/`, `src/orchestrator/retry.ts`.
- Structured reviewer verdict schema, treated as **advisory** and validated/rejected
  if malformed — `src/review/reviewer.ts`.
- Redaction defaults + argv-only invocation — `src/security/redact.ts`, `src/process/`.

**Rejected / de-scoped**
- The conversational wizard as the *only* path: `agent-loop` supports it
  (interactive plan approval) but defaults to non-interactive `--auto` with recorded
  assumptions, because the product must run unattended.
- Emitting a standalone Python runner: `agent-loop` is the runner.
- "Scaffolder never executes" boundary: deliberately inverted — execution is the point.

---

## 3. Ralph (`ralph-main/`) — MIT, "snarktank"

A ~120-line bash loop that runs a fresh agent each iteration against a `prd.json`,
implementing one user story per pass, persisting learnings in `progress.txt`.

**Useful concepts found**
- **Fresh context per iteration** — each pass is a clean agent instance; forces small,
  well-sized work units.
- **Machine-readable PRD** (`prd.json`) with `userStories[]`, each having
  `id`, `title`, `description`, `acceptanceCriteria[]`, `priority`, `passes`, `notes`.
- **Persistent memory** across sessions via git history + an append-only learnings log.
- **Dependency ordering** by `priority` (schema → backend → UI).

**Selected for `agent-loop`**
- Fresh, focused **context pack per slice** (no growing conversation) —
  `src/orchestrator/context.ts`.
- PRD intake: Ralph-style `prd.json` and Markdown PRDs are accepted input formats —
  `src/intake/normalize.ts`.
- Persistent memory between runs via the durable event store + verified git commits
  (a strict superset of `progress.txt`).
- Dependency-ordered execution via an explicit DAG — `src/planner/graph.ts`.

**Rejected / de-scoped (critical)**
- **Trusting the agent's completion signal.** Ralph greps stdout for
  `<promise>COMPLETE</promise>` and the agent decides when all stories `passes:true`.
  This is precisely the anti-pattern the product forbids. In `agent-loop`, completion
  is **never** derived from agent text; it is `verified completed slices / total
  slices`, where "verified" means the deterministic verifier passed and a scoped
  commit exists.
- The agent writing `prd.json`/`progress.txt` as authoritative state. In `agent-loop`
  the orchestrator owns all status; the agent's file claims are advisory only.
- `--dangerously-allow-all` / `--dangerously-skip-permissions` by default.

---

## 4. ui-loop (`ui-loop/`) — UNLICENSED (ideas only, no code copied)

A TypeScript v0 deterministic loop harness: event-sourced state, deterministic
verifier with no LLM in the control spine, scoped commits, rollback, crash recovery.
The closest in spirit to this product.

> **Licensing constraint.** ui-loop has **no LICENSE file**. Under default copyright,
> copying is not permitted. Therefore only architectural *ideas* were studied;
> `agent-loop` uses original code, original module boundaries, original state/event
> names, and original schemas. No verbatim functions, types, or fixtures were taken.

**Useful concepts found (studied conceptually)**
- **Event sourcing as the spine:** append-only log is the source of truth; a pure
  fold reconstructs state; survives `kill -9`.
- **Verifier independence:** the verifier sees only git diff + slice/config, never the
  worker's stdout or reasoning; LLM reviewers can block but never override a failed
  deterministic check.
- **Scoped commits:** stage only the files the slice changed; embed a slice-id trailer
  to reconcile git-ahead-of-log on resume.
- **Worker output is advisory:** the orchestrator always reads the *real* diff from git.
- **Staged checks:** cheap safety scans (secrets, scope, size) first, expensive checks
  (typecheck/lint/test) last, short-circuit on first hard failure.
- **Read-only watch dashboard** that derives everything from the log + git.
- **Blocker → human file** protocol with `resume`.

**Improvements `agent-loop` makes over ui-loop (its documented gaps)**
- **Bounded retries with context refinement** ("your last attempt failed because Y")
  instead of ui-loop's v0 zero-retry → immediate block.
- **Real planner + intake** from idea/PRD/issue/stdin, not a hand-written PRD only.
- **Multi-provider / multi-model routing by role** with fallback and weighting.
- **Safe parallel slices** via worktrees with path-ownership analysis.
- **SQLite (WAL) event store** with sequence numbers, transactions, and migrations,
  rather than a single NDJSON file (NDJSON retained as an optional export).
- **IPC control plane** so the watcher can pause/resume/stop without editing state.
- **Structured reviewer schema** with validation. (An optional browser/UI verifier is
  now wired — real headless Chrome via the DevTools Protocol with a zero-dependency HTTP
  fallback; see `src/verify/browser.ts` and [verification.md](verification.md). It is
  advisory by default and runs only after a verifier pass, so it never overrides the
  deterministic verifier.)

**Selected for `agent-loop` (reimplemented clean-room)**
- Event-sourced spine + pure projection — `src/events/`.
- Deterministic, model-independent verifier as the authority — `src/verify/`.
- Scoped commits with a slice-id trailer + resume reconciliation — `src/git/`.
- Advisory worker output; git is the truth — `src/orchestrator/executor.ts`.
- Read-only, reconnectable watch dashboard — `src/watch/`.

---

## 5. Synthesis

`agent-loop` combines: **role-specialized providers + worktree isolation + SQLite
event sourcing** (Go Looper); **typed verification taxonomy + canonical compiled spec
+ explicit termination guards + redaction** (Looper skill); **fresh context per unit +
PRD intake + dependency ordering** (Ralph); and a **deterministic event-sourced spine
with verifier independence, scoped commits, and crash recovery** (ui-loop, ideas only).

The unifying invariant — taken from none of them wholesale and enforced everywhere —
is the **core principle**: *the agent is a worker, not the source of truth.* Progress
and completion are computed exclusively from objective runtime evidence (git state,
exit codes, verifier results), never from agent-authored text.
