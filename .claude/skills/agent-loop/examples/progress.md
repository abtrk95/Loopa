# Example — progress and recovery

## "Where are we?"

**User:**

> Where are we?

**Skill:**

> I'll check the current run — all read-only:
>
> ```bash
> agent-loop status        # verified state + progress
> agent-loop inspect       # why each slice is where it is
> agent-loop watch --once  # one-shot dashboard snapshot
> ```

**Skill:** *(explaining the output)*

> The run is **RUNNING**: 2 of 3 pieces verified and committed; it's currently working on
> "results list." Progress is *verified-completed / total* — a piece only counts when the
> deterministic verifier confirms it, not when the agent claims it's done. Nothing has been
> merged or deployed. Want a live view? `agent-loop watch`.

## "Why is it blocked?"

**User:**

> Why is it blocked?

**Skill:**

> Let me look — read-only:
>
> ```bash
> agent-loop status
> agent-loop inspect
> agent-loop logs
> ```

**Skill:** *(summarizing in plain English)*

> A **BLOCKED** run is the **safety system working**, not a crash. Here:
>
> - **What failed:** the "query API" slice tried to edit a file outside its allowed scope,
>   so the verifier stopped it.
> - **What was committed:** the first slice ("search UI") is committed and verified; the
>   blocked work is **not** committed.
> - **What you can do next:** this one needs a small scope fix — I'd recommend a developer
>   look, since it's about file boundaries. Once the cause is fixed, I can resume with
>   `agent-loop retry` (it re-attempts only the unfinished work and never merges/deploys) —
>   but I'll confirm with you before running it.
> - **Developer needed?** For a scope/secret/test-integrity blocker, yes — loop one in.

**Why this is safe**

- Diagnosis is entirely read-only.
- `retry` (an execute action) is **confirmed before running**.
- The skill is honest about what's committed vs. not, and recommends a developer when the
  blocker calls for one.
