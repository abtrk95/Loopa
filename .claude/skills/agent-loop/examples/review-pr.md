# Example — review a PR in plain English

**User:**

> Is PR 11 safe?

**Skill:**

> I'll generate a plain-English review report from the objective run evidence. This is
> **read-only** — it posts nothing to GitHub:
>
> ```bash
> agent-loop github pr review --repo acme/widgets --pr 11
> ```
>
> I won't post a comment unless you approve.

**Skill:** *(after reading the report)*

> Verdict: **🟢 SAFE TO REVIEW** (risk: Low)
>
> - **What changed:** Added a ticket search box and results list.
> - **Why:** To address issue #123.
> - **Checks:** Tests ✅ · Build ✅ · Typecheck ✅ · Lint ✅ · Secrets ✅ · Forbidden files ✅
> - **Risks:** None flagged by the automatic checks. A dependency lockfile changed —
>   confirm that was intended.
> - **What you should manually test:** Open the app, search a known ticket, confirm it
>   appears; check the empty-state message.
> - **Recommendation:** This is trustworthy enough for **you** to review. Do the manual
>   checks above, then **merge by hand** if happy. I can't and won't merge it for you, and
>   "SAFE TO REVIEW" is not "safe to merge blindly."
>
> Want me to post this report as a comment on PR 11? That's a write, so I'll only do it
> with your go-ahead:
> `agent-loop github pr review --repo acme/widgets --pr 11 --comment --apply`

**If the verdict were different**

- **🟡 NEEDS HUMAN DEV REVIEW** → "Checks passed, but there are signals a developer should
  confirm. Ask a developer before merging."
- **🔴 DO NOT MERGE** → "Do not merge — the work is incomplete / failed checks, or the
  reviewer raised a blocking concern."
- **⛔ BLOCKED** → "A hard safety rule stopped the work. Do not merge; this needs a developer."

**Why this is safe**

- The report is read-only; **posting requires explicit approval** (`--comment --apply`).
- The skill never says "safe to merge," and never lets the AI reviewer override the
  deterministic verifier. The verifier is the final authority; a human merges.
