# Non-technical PR review

This guide is for a **product owner who is not a developer** but wants to use
agent-loop safely on a real project. It explains the plain-English review report,
what its verdicts mean, what still needs your judgement, and why the tool never
merges or deploys for you.

> The one rule that makes this safe: **a human always merges.** agent-loop never
> merges, deploys, or closes issues automatically. It does the work, checks it
> objectively, and hands you a clear report. You decide.

---

## The command

```bash
agent-loop github pr review --repo <owner>/<name> --pr <number>
```

This builds a plain-English report from the **objective record of the run** — not
from anything the AI "claims". It is written to:

```
.agent-loop/reports/pr-review-<number>.md
```

By default it is **read-only**: it writes a local file and prints a verdict;
it does not touch GitHub. To also post the report as a comment on the PR:

```bash
agent-loop github pr review --repo <owner>/<name> --pr <number> --comment --apply
```

`--comment` says "post it"; `--apply` actually performs the write (without
`--apply` you get a dry-run preview and nothing is posted). `--json` prints the
verdict/risk/recommendation as machine-readable JSON.

You can also run it without `--pr` to review the most recent local run by its
branch (handy right after a run, before you open the PR).

---

## What the report contains

Every section is built from evidence the tool actually observed:

| Section | Where it comes from |
| --- | --- |
| **Verdict** | The deterministic verifier result + safety scans + AI reviewer, combined by a fixed rule |
| **Plain-English summary** | The goal + what completed, in everyday language |
| **What changed / Why** | Completed work items + the linked issue |
| **Checks** | Tests / build / typecheck / lint pass-fail from the real check runs |
| **Security & safety** | Secret scan, forbidden-path scan, protected-location scan, test-integrity, conflict-marker scan |
| **Main risks** | Concrete concerns the checks surfaced |
| **What you should manually check** | The issue's acceptance criteria + reviewer suggestions + screenshots |
| **Screenshots & browser evidence** | Real screenshots/console captures, when browser verification ran |
| **Files changed** | Grouped into friendly categories (Tests, User interface, App logic, …) |
| **Technical details** | A collapsible section for a developer |

---

## What the verdicts mean

| Verdict | Plain meaning | What to do |
| --- | --- | --- |
| 🟢 **SAFE TO REVIEW** | Everything automatic passed; nothing risky was flagged. | Read the report, do the manual checks, then **merge by hand** if happy. |
| 🟡 **NEEDS HUMAN DEV REVIEW** | Automatic checks passed, but there are signals a developer should confirm (high-risk area, reviewer concerns, an advisory UI check that didn't fully pass). | Ask a developer to look before merging. |
| 🔴 **DO NOT MERGE** | The work is incomplete or did not pass automatic checks, or the AI reviewer raised a blocking concern. | Do **not** merge. Send it back / ask a developer. |
| ⛔ **BLOCKED** | A hard safety rule stopped the work (a secret, a protected/forbidden file, a `.git` write). | Do **not** merge. This needs a developer; something unsafe was attempted. |

**"SAFE TO REVIEW" does not mean "safe to merge blindly."** It means the evidence
is trustworthy enough for *you* to review, and the manual checks are the last step
before *you* merge.

---

## The most important guarantee: the verifier is the authority

agent-loop runs two kinds of review:

1. A **deterministic verifier** — a fixed program that checks the real changes:
   did the tests pass? are there secrets? was a forbidden file touched? It does not
   use AI and cannot be talked out of a failure.
2. An **AI reviewer** — a second model that reads the change and gives an opinion
   in plain English.

**The AI reviewer can never overrule the verifier.** If the verifier failed, the
report says **DO NOT MERGE** even if the AI reviewer "liked" the change. The AI can
only *add* concerns or *flag* a block — never approve over a failed check. This is
enforced in code and covered by tests.

---

## What still needs your judgement

The tool is honest about its limits. You are still responsible for:

- **Does it actually do what you wanted?** Open the app and try the feature. The
  report lists the acceptance criteria as a checklist.
- **Does it look right?** If there are screenshots, open them.
- **Business correctness.** The tool checks that code is safe and tests pass — not
  that the feature is the right product decision.
- **The final merge.** Always you, never the tool.

---

## A safe first real-project workflow

1. **Triage** your issues so the tool tells you which are clear and safe:
   ```bash
   agent-loop github triage --repo <owner>/<name> --all          # preview
   agent-loop github triage --repo <owner>/<name> --all --apply --comment
   ```
   Issues become `ready`, `needs-info`, `too-risky`, or `unsupported`. Only run
   work on `ready` issues.

2. **Run one ready, low-risk issue** with a real provider, producing a draft PR:
   ```bash
   agent-loop github run-issue --repo <owner>/<name> --issue <N> \
     --auto --pr --apply --interview quick
   ```
   Use concurrency 1 and draft PRs (both are the defaults). Nothing merges.

3. **Get the plain-English review:**
   ```bash
   agent-loop github pr review --repo <owner>/<name> --pr <PR-number>
   ```

4. **Read the verdict, do the manual checks, then merge by hand** (on GitHub) if
   you're happy. If the verdict is anything other than SAFE TO REVIEW, loop in a
   developer.

### Which issues are safe vs. unsafe to hand to the tool

| Safe | Unsafe / needs a human first |
| --- | --- |
| Clear feature with written acceptance criteria | Vague ("make it better") — triage will ask for detail |
| Self-contained UI or logic change | "Add production secrets and deploy" — triage marks too-risky; the tool will not do it |
| Anything with tests you can read | Anything touching real credentials, production infra, or money |

---

## Why the tool does not auto-merge or auto-deploy

Because **objective checks passing is not the same as a feature being correct,
wanted, and safe to ship.** A human reviewing a clear, evidence-backed summary
catches the things automation cannot. agent-loop is built to make that human review
fast and trustworthy — not to remove it. There is deliberately no merge, deploy, or
issue-close capability in the tool at all.

---

## Worked example (verbatim verdict block)

```
PR review verdict: SAFE TO REVIEW  (risk: Low)
Safe for you to review. Merge after completing the manual checks below.
(You still merge by hand — nothing is automatic.)
Report: .agent-loop/reports/pr-review-10.md
```

See `docs/verification.md` for how the deterministic verifier works, and
`docs/github-triage-kanban.md` for the triage/PR workflow.
