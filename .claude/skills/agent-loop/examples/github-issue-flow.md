# Example — run a GitHub issue safely

**User:**

> Run issue 123.

**Skill:**

> I'll need your repo (e.g. `acme/widgets`). Before running anything, I'll **triage** the
> issue to confirm it's clear and low-risk, then **preview** the plan — neither touches
> GitHub or runs code:
>
> ```bash
> agent-loop github triage --repo acme/widgets --issue 123      # read-only preview
> agent-loop github import --repo acme/widgets --issue 123 --interview quick   # local plan, no run
> ```
>
> I will **not** start execution until you approve.

**User:**

> looks good, go

**Skill:**

> Confirming before I execute: this **starts the autonomous loop now** (real provider
> tokens), updates the issue's status labels on GitHub, and opens a **draft** PR. It never
> merges or deploys. Command:
>
> ```bash
> agent-loop github run-issue --repo acme/widgets --issue 123 --auto --pr --apply --interview quick
> ```
>
> Proceed?

**User:**

> yes

**Skill:** *(after the run)*

> Done — it opened a **draft** PR. Next I'll generate the plain-English review (read-only):
>
> ```bash
> agent-loop github pr review --repo acme/widgets --pr <PR#>
> ```
>
> I'll explain the verdict, then you do the manual checks and **merge by hand** if happy.

**Why this is safe**

- `triage` and `import` (read-only / local) come *before* any execution.
- `run-issue` is correctly treated as **execution, not a preview** — confirmed first, with
  its cost and GitHub writes stated.
- Only a **draft** PR is opened. Nothing merges, deploys, or closes the issue.
