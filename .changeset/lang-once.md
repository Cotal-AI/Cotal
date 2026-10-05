---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Add `once`, an at-most-once scope for cotal-lang steps that write to a far side. A resume that finds a step inside `once` begun and never settled does not dispatch it again: it opens a hold, a checkpoint minted under `holdRequestId` of the step's recorded request id, and the answer becomes the step's result, while an expired hold fails the step with the catchable L4027. A hold the host refuses leaves the step pending rather than refused, so no later host writes again. Only `ask` runs inside `once`; every other effect is refused before it begins (L4028), and a write from the body to a binding outside it is refused (L2032). The journal entry gains a `hold` field for the hold's own binding. The hosted runtime ends the held `ask`'s open attempt pause before the hold binds, and `cotal run answer`, `cotal run amend` and `cotal run journal` read a held step at its hold. A fork may cut inside `once`, and a migration ignores an orphaned `once`. `once` becomes a reserved name, so a program that declares its own `once` binding is refused (L2002). The design record is `docs/design/at-most-once-external-effect.md`.
