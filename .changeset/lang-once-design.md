---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Add the design record for `once`, an at-most-once scope for cotal-lang steps that write to a far side, in `docs/design/at-most-once-external-effect.md`. A resume that finds a step inside `once` begun and never settled does not dispatch it again: it opens a hold, an ordinary checkpoint minted under a hold id derived from the step's recorded request id, and the settler's value becomes the step's result, while an expired hold fails the step with the catchable L4027. A held `checkpoint` records the hold's raw outcome, so its own `onExpiry` still applies, and a checkpoint with `onExpiry: "escalate"` inside `once` is refused before it begins (L4028), because its second attempt would be a second dispatch. The record fixes the surface, the journal's new `hold` field, the hosted runtime's pause authority, adoption, discharge and answer path for a hold, the insertion-only normative text and the acceptance runs. `once` becomes a reserved name, so a program that declares its own `once` binding is refused (L2002). No package behavior changes in this revision.
