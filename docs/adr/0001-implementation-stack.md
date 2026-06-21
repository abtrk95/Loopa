# ADR 0001 — Implementation stack

- **Status:** Accepted
- **Date:** 2026-06-21
- **Decision owner:** agent-loop architecture

## Context

`agent-loop` is a local-first, evidence-driven autonomous coding loop (beta). It must:
orchestrate subprocesses (git, project build/test commands, and provider CLIs);
maintain a durable, crash-safe, append-only event store; render a live terminal
dashboard that can attach/detach/reconnect; validate rich structured schemas; and be
covered by deterministic automated tests with no paid API calls.

The reference projects span four ecosystems: Python (Looper skill), Go (Looper
daemon), Bash (Ralph), and TypeScript (ui-loop). The brief permits either a
TypeScript implementation with a mature TUI approach, or a Go implementation with a
mature terminal framework, and asks for a single-language architecture.

## Options considered

### A. Go (cobra + bubbletea + mattn/go-sqlite3)
- **Pros:** single static binary; excellent process management; strong typing; the Go
  Looper proves the pattern.
- **Cons:** `go-sqlite3` requires cgo/native compilation (portability friction);
  slower iteration for a large surface in one build cycle; TUI snapshot testing is
  less ergonomic; the provider integrations are all subprocess CLIs, so Go's
  concurrency advantage is marginal here.

### B. TypeScript on Node 22 (chosen)
- **Pros:**
  - **Built-in SQLite** via `node:sqlite` (Node ≥ 22.5) with WAL — **zero native
    compilation**, no `node-gyp`. Confirmed available in this environment.
  - First-class subprocess control (`child_process` with detached process groups,
    signals, streaming, bounded buffers) — exactly what the process manager needs.
  - `zod` gives runtime-validated schemas that double as static types — ideal for the
    canonical spec, events, and config precedence.
  - `vitest` enables fast, deterministic unit + integration + snapshot tests; the TUI
    is a pure string renderer, so dashboard rendering is snapshot-testable without a
    real terminal.
  - Closest in spirit to ui-loop (the strongest reference), easing clean-room reuse of
    its *ideas* while improving on its gaps.
  - The provider ecosystem we target (`claude`, `codex`, `opencode`) is invoked as
    subprocesses — language-agnostic, trivial from Node.
- **Cons:** distributes as JS + a Node runtime rather than a single binary;
  `node:sqlite` is marked experimental (mitigated below).

### C. Mixed-language
- Rejected outright per the brief: no compelling reason; adds packaging and
  maintenance cost.

## Decision

**TypeScript on Node.js 22, ESM, strict mode.** The decisive factors are
testability (deterministic vitest suite for the whole engine and a string-rendered
dashboard), zero-native-dependency durable storage (`node:sqlite` WAL), and best-in-
class subprocess control for an orchestrator whose providers are all CLIs.

### Key dependencies (deliberately minimal)
- `zod` — runtime schema validation + inferred static types.
- `yaml` — config parsing (`.agent-loop/config.yml`).
- Everything else (SQLite, child processes, fs, terminal sizing) uses the Node
  standard library. The TUI is hand-rendered ANSI — no heavy framework — honoring the
  anti-goal "a visually impressive TUI hiding an unreliable engine."

### Mitigations
- **`node:sqlite` experimental warning** is suppressed narrowly
  (`--no-warnings=ExperimentalWarning` in our own scripts; a targeted filter in the
  store module). The storage layer sits behind an `EventStore` interface, so the
  backend can be swapped without touching callers if the API changes.
- **Locked dependency versions** (exact, no `^`) for reproducible builds.
- **`engines.node >= 22.5`** is enforced; `agent-loop doctor` checks the runtime.

## Consequences

- We get a fully deterministic, fake-provider test suite with no paid API calls.
- The dashboard is unit-testable as pure functions over a snapshot model.
- Distribution requires Node ≥ 22.5 (documented in README prerequisites).
- If `node:sqlite` graduates or changes API, only `src/events/store.ts` changes.

This decision is made and acted on without waiting for approval, per the brief.
