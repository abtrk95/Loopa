# Phase 5 — Interview Recommendations Validation

**Date:** 2026-06-22 · Repo: `abtrk95/supportdesk-lite-agent-loop-e2e-20260622-113042`
**Binary:** `dist/bin/agent-loop.js` (built from `final-realistic-readiness-validation`)

## Result: PASS

Every interview question carries a complete, repo-grounded recommendation, and the
interview asks the full set of agent/model orchestration questions. The vague issue
produces a conservative single slice with explicitly low-confidence assumptions — **not**
fabricated requirements.

## How it was validated (three independent angles)

### 1. Unit tests (completeness proof) — 49 passed
```
npx vitest run test/unit/recommend.test.ts test/unit/interview.test.ts test/unit/intake.test.ts
→ recommend.test.ts (18) · interview.test.ts (26) · intake.test.ts (5) = 49 passed
```
`recommend.test.ts` asserts directly:
- *"every recommendable key yields all 7 fields populated"* (`recommended`, `why`, `risk`, `safeDefault`, `alternatives`, `required`, + `question`).
- *"orchestration catalog keys all have a recommender"* (no orchestration question lacks a recommendation).
- *"formatRecommendation renders every labeled section"* — `Question:`, `Recommended:`, `Why:`, `Alternatives:`, `Risk:`, `Default:` and an `Optional.`/`Required.` marker.
- Grounding: high-risk goals → `risk=high` (never lowered); UI goals → browser `y`; auth/payment → distinct reviewer + consensus; plain util → reviewer `none`.

### 2. Live rendered interview (pty-driven, against the real repo)
Drove `plan --idea … --interview <mode>` over a pty, pressing Enter (accept recommended) at each prompt. Full transcripts:
- `reports/final-readiness-evidence/phase5-interview-standard-billing.txt` — **15 questions**, each rendering all 7 sections + `Optional./Required.`
- `reports/final-readiness-evidence/phase5-interview-strict-auth.txt` — **23 questions** (adds strict-only questions)

Every required orchestration topic is asked (verified present in the transcripts):

| Topic required by spec | Question asked | Mode |
| --- | --- | --- |
| planner provider/model | "Planner provider/model — who decomposes the work into slices?" | standard |
| worker provider/model | "Worker provider(s)/model(s) that execute slices…" | standard |
| number of workers / concurrency | "How many slices may run in parallel (concurrency)?" | standard |
| reviewer provider/model | "Reviewer provider/model — 'none' for the deterministic verifier only?" | standard |
| reviewer consensus | "Require consensus from multiple distinct reviewers? (y/N)" | strict |
| fixer strategy | "Fixer strategy — 'same-as-worker' or a dedicated provider?" | strict |
| fallback provider | "Fallback provider when the primary fails — 'none' to disable?" | strict |
| switch-on-retry | "Switch to another provider on retry…? (y/N)" | strict |
| browser required/advisory/off | "Is browser/UI verification needed?" + "Make browser/UI verification required (blocking)…?" | standard |
| GitHub PR flow | "Is GitHub / PR integration needed? (y/N)" | standard |
| auto mode safety | "Can this run autonomously without prompts? (y/N)" | standard |
| human approval gates | "Human approval checkpoints required…" | strict |

**Grounding observed (recommended values fit the input + detected repo + providers):**
- planner → `claude` ("claude is installed and strong at decomposing work…").
- concurrency → `1` ("Begin conservatively… overlapping scopes serialize anyway").
- browser-required for the high-risk UI goal → `y` ("High-risk UI work: make browser verification BLOCKING").
- strict high-risk auth+payment goal → consensus `2`, browser `required` (shown in the orchestration summary).
- reviewer recommended **distinct** from worker (e.g. `codex` when worker is `claude`).

### 3. `--accept-recommended` (non-interactive) end-to-end
```
plan --idea "Add a billing settings page with validation and tests" --interview standard --accept-recommended
```
→ "Interview (standard) complete. Recorded 15 assumption(s)." then a resolved **Orchestration** block:
`planner: claude · workers: claude · reviewer: codex · fixer: same-as-worker · concurrency: 1 · consensus: 1 · browser: required · github: on · auto: false` — with the explicit caveat *"these are applied to THIS run; pass --write-config to persist"* and *"verifier remains authoritative; AI roles can never override it."* No hang, no prompt.

GitHub import path also exercised:
```
github import --repo <r> --issue 1 --interview standard --accept-recommended   → plan (1 slice), browser advisory
github import --repo <r> --issue 4 --interview strict   --accept-recommended   → plan (1 slice), fallback codex + switch-on-retry
```

## Vague Issue 4 — conservative, not fabricated (PASS)
`Make the dashboard better` (strict interview, accept-recommended) →
- **1 slice** `S-001 [low] Make the dashboard better`, `allowedPaths: ["**"]`.
- Acceptance criteria **defaulted** (not invented): `["… works end-to-end", "all verification checks pass"]`.
- `assumptions.md` flags every gap honestly with **"(low confidence — verify)"** — e.g. "No user-visible behavior specified.", "Existing architecture not described…". It does **not** assert that requirements are complete.

> The interview's clarification-question surface for "needs-info" issues is exercised end-to-end in **Phase 6 (triage `--comment`)**. The deterministic planner intentionally emits one conservative slice for a vague goal rather than several confident ones.

## Notes / minor findings
- The interview records *"Assumed default branch 'main'"* even though this repo's default is `master`. This is a recorded assumption only; PR base resolution uses `gh`'s repo default (`--base` omitted), so it does not affect PR targeting. Flagged for the single-provider run (Phase 7) to confirm no impact. **Severity: cosmetic.**
- `interview` (bare) with no `--idea`/`--prd` and `--accept-recommended` correctly errors with *"no goal captured"* (goal is the one required field with no safe default) — by design.

**Phase 5 verdict: PASS.** Recommendations are present, complete, grounded, and honestly bounded; orchestration questions cover the full matrix; vague input degrades safely.
