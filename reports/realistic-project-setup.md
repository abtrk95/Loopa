# Phase 2 — Realistic Disposable Project Setup

**Date:** 2026-06-22

## Disposable GitHub repository

| Field | Value |
| --- | --- |
| Name | `supportdesk-lite-agent-loop-e2e-20260622-113042` |
| Owner | `abtrk95` |
| Full name | `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042` |
| Visibility | **PRIVATE** |
| URL | https://github.com/abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042 |
| Default branch | `master` |
| Local workspace | `/Users/abtrk/Dev/loop/e2e-supportdesk-20260622-113042` |
| Baseline commit | `386704a chore: scaffold SupportDesk Lite baseline (ticket list + tests)` |

> This is a throwaway repo created solely for this validation. It will be archived at the end (Cleanup). It contains **no real secrets**.

## App: SupportDesk Lite

A lightweight internal support-ticket dashboard. **No auth, no database, no deployment**; in-memory fixture data only.

**Stack:** TypeScript + React 18 + Vite 6 + Vitest 3 + @testing-library/react (jsdom) + ESLint 9 (flat config).

**Baseline app contents:**
- `src/App.tsx` — app shell with a Tickets section
- `src/components/TicketList.tsx` — read-only ticket table (with empty state)
- `src/data/tickets.ts` — in-memory mock tickets (4 fixtures)
- `src/types.ts` — `Ticket` / `Priority` / `TicketStatus` types + `PRIORITIES`/`STATUSES`
- `tests/data.test.ts` — fixture-data invariants (3 tests)
- `tests/ticketList.test.tsx` — component render tests (3 tests)
- `tests/setup.ts` — jest-dom matchers
- `index.html`, `src/main.tsx`, `src/index.css`

**Scripts (package.json):**
| Script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `vite --port 5173 --strictPort` | dev server (browser verification target) |
| `npm test` | `vitest run` | unit/component tests |
| `npm run build` | `tsc --noEmit && vite build` | typecheck + production build |
| `npm run typecheck` | `tsc --noEmit` | strict typecheck |
| `npm run lint` | `eslint .` | flat-config lint |
| `npm run preview` | `vite preview --port 4173 --strictPort` | serve built app |

## Baseline verification (local, before push)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm test` | PASS — **6 passed (2 files)** |
| `npm run build` | PASS — 29 modules transformed, dist emitted |

> `npm install` reported 4 advisories (2 low / 1 moderate / 1 high) in the **dev** toolchain (vite/esbuild transitive). Not relevant to agent-loop and not shipped; left as-is for a disposable test repo.

## Protected / forbidden paths (defined)

Documented in the repo `README.md` and `.gitignore`, and enforced by agent-loop config (Phase 4) via `riskPolicy.globalForbiddenPaths`:

- `.env`, `.env.*`
- `secrets/**`
- `infra/production/**`
- `.git/**`

No real secrets were added. (`agent-loop` also unions these with its built-in default forbidden paths.)

## Note for later phases
- Repo default branch is **`master`** — PR base must target `master` (agent-loop `--base master`, or set `github.base`). agent-loop's default PR base resolution / `--base` flag will be used explicitly in run-issue/pr phases to avoid a `main`/`master` mismatch.
