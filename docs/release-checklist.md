# Release checklist

agent-loop ships only when every gate below is green, with the command output recorded.
Honesty rule: **do not label a build "production-ready"** unless all evidence supports it.
The current label is **release candidate** (`0.2.0-rc`) — see the README Status section.

## Pre-release gates (all must pass)

| # | Gate | Command | Pass criteria |
| --- | --- | --- | --- |
| 1 | Clean install | `npm ci` | exits 0 |
| 2 | Typecheck + lint + tests | `npm run check` | exits 0; all tests pass (opt-in tests skipped) |
| 3 | Build | `npm run build` | exits 0; `dist/bin/agent-loop.js` is `+x` |
| 4 | End-to-end demo (no creds) | `node dist/bin/agent-loop.js demo` | `COMPLETED (3/3 slices verified)` |
| 5 | Production dependency audit | `npm audit --omit=dev --audit-level=high` | no high/critical in shipped deps |
| 6 | Package contents | `npm pack --dry-run` / `npm run verify:pack` | ships `dist/` + `docs/` + README + notices; **no** `src/`/`test/`/configs |
| 7 | Clean-clone build | `git archive HEAD | tar -x -C $(mktemp -d)` then `npm ci && npm run build && node dist/bin/agent-loop.js demo` | all succeed from a fresh checkout |

A single shortcut runs 2–6: `npm run release:check`.

## Optional (opt-in) provider/integration smoke

These never run in the default suite. Run them when validating against real tooling
(they require the CLIs installed + on `PATH`; the live ones spend tokens / hit GitHub):

```bash
# Real provider version/health (no tokens):
AGENT_LOOP_SMOKE_CLAUDE=1 AGENT_LOOP_SMOKE_CODEX=1 AGENT_LOOP_SMOKE_OPENCODE=1 npm test -- provider-smoke
# Real headless-Chrome (CDP) browser verification:
AGENT_LOOP_SMOKE_BROWSER=1 npm test -- browser-verify
# Live coding session (SPENDS REAL TOKENS, double-gated):
AGENT_LOOP_SMOKE_LIVE=1 AGENT_LOOP_SMOKE_LIVE_PROVIDER=claude npm test -- provider-smoke
# Read-only GitHub access against a throwaway repo:
AGENT_LOOP_GH_LIVE=1 AGENT_LOOP_GH_LIVE_REPO=your-org/throwaway npm test -- github-pr
```

## Documentation accuracy

- [ ] README Status section matches reality (no "production-ready" claim unless earned).
- [ ] `judge` role still marked **reserved** (it is not wired) in README + configuration.md.
- [ ] Any newly-wired capability (browser verification, distinct reviewer consensus,
      artifact privacy, stale-PID recovery) is documented and exercised by a shipped test.
- [ ] `docs/production-readiness-audit.md` remediation/limitation tables reflect the build.

## Versioning & publish

- [ ] Bump `package.json` `version` (RC builds use a `-rc.N` suffix).
- [ ] CI is green on the gating matrix (Linux + macOS); the Windows job is non-blocking.
- [ ] **Not yet for publish:** the package is `private: true` and has no `LICENSE`.
      Before any real `npm publish`, remove `private`, add a `LICENSE`, decide on a
      `prepare`/`prepublishOnly` build hook, and re-run this checklist.

## What "release candidate" means here (and what it does not)

RC = the deterministic core and the operational/safety hardening are implemented, tested,
and honestly bounded; the documented quick-start works; the package builds from a clean
clone and packs the right files. It is **not** "production-ready" because: real
multi-provider runs are proven hermetically but not at scale / in CI; Windows is
unsupported; the package is unpublished (private, no license). Promote to a stable release
only when those are addressed and the evidence supports the stronger claim.
