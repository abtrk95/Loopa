# Example — start from an idea

**User:**

> I want to add ticket search.

**Skill:**

> This is a product change, so I recommend the **standard** interview first — it asks a
> few clarifying questions before planning. This step is **planning only** (no code runs,
> nothing is published). I'll run:
>
> ```bash
> agent-loop plan --idea "Add ticket search" --interview standard
> ```
>
> Proceed?

*(If the project isn't set up yet, the skill first suggests the read-only-safe
`agent-loop init`.)*

**User:**

> yes

**Skill:** *(after planning)*

> Here's the plan it produced — 3 slices: search UI, query API, results list. All low
> risk. Running it will execute the autonomous loop with a real provider (this spends
> tokens). The safe default keeps a human approval gate:
>
> ```bash
> agent-loop run --watch
> ```
>
> If you'd rather it run unattended (no approval checkpoint mid-run), I can use
> `agent-loop run --auto --watch` instead — but I'd only do that once you confirm you
> understand it removes the checkpoint. Which do you want?

**Why this is safe**

- Planning is run freely; **execution is confirmed first** and the safe `run` (with its
  approval gate) is the default.
- Nothing is merged or deployed — agent-loop only ever produces a local branch / draft PR.
- The skill states the cost (real provider tokens) before spending them.
