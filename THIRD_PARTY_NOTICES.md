# Third-Party Notices

`agent-loop` is a **clean-room** implementation. It was designed by studying four
reference projects and reimplementing their *ideas* in new TypeScript code. No
substantial source code was copied from any reference repository.

This file records (a) the provenance of the concepts and (b) the licenses of the
runtime dependencies that ship with the product.

---

## 1. Reference projects (research material only — no code copied)

These repositories were read as design research. `agent-loop` contains no copied
source from them. Where a project is MIT-licensed, its copyright notice is
preserved below as a courtesy and to document provenance even though no code was
reused.

### Go Looper — `looper-main 2/`
- **License:** MIT
- **Copyright:** `Copyright (c) 2026 looper contributors`
- **Concepts studied (reimplemented clean-room):** role-specialized loops
  (planner/worker/reviewer/fixer/coordinator), git worktree isolation per unit of
  work, SQLite event sourcing, structured agent completion markers, provider/vendor
  adapter abstraction, GitHub-as-authority integration, bounded retry queues.

### Looper skill/design — `looper-main/`
- **License:** MIT
- **Copyright:** `Copyright (c) 2026 Kevin Simback`
- **Concepts studied (reimplemented clean-room):** structured goal intake, typed
  verification taxonomy (programmatic / judge / human), canonical spec schema split
  (human-authored source → compiled/resolved runtime form), explicit termination
  guards, cross-model review council with privacy/redaction defaults.

### Ralph — `ralph-main/`
- **License:** MIT
- **Copyright:** `Copyright (c) 2026 snarktank`
- **Concepts studied (reimplemented clean-room):** PRD-driven execution, one unit of
  work per iteration, fresh context per iteration, persistent memory between
  sessions, machine-readable acceptance criteria. (Its agent-self-assessed
  completion signal was deliberately **rejected** — see `docs/reference-analysis.md`.)

### ui-loop — `ui-loop/`
- **License:** **NONE** (no LICENSE file present; the repository is unlicensed).
- **Consequence:** Under default copyright, no permission is granted to copy, modify,
  or distribute its source. `agent-loop` therefore copied **no code** from ui-loop.
  Only high-level architectural *ideas* (event-sourced deterministic control spine,
  verifier independence, scoped commits, crash recovery via replay) were studied and
  reimplemented from scratch with original code, original module boundaries, and
  original schemas/state names. No verbatim functions, type definitions, or test
  fixtures were taken.

---

## 2. Runtime dependencies (shipped)

| Package | Version | License |
| ------- | ------- | ------- |
| [`zod`](https://github.com/colinhacks/zod) | 3.24.1 | MIT |
| [`yaml`](https://github.com/eemeli/yaml) | 2.6.1 | ISC |

The Node.js standard library (including the experimental `node:sqlite` module) is
used under the Node.js license. No native add-ons are compiled.

## 3. Development-only dependencies

`typescript`, `tsx`, `vitest`, `eslint`, `@typescript-eslint/*`, and `@types/node`
are used for building and testing only and are not distributed with the product.
All are MIT/Apache-2.0 licensed.

---

## 4. License of `agent-loop` itself

No license has been assigned to this project. Per the workspace owner's instruction,
a license will be added only when the owner specifies one. Until then, all rights
are reserved by the workspace owner.
