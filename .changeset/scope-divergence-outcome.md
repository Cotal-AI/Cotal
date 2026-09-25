---
"@cotal-ai/lang": patch
---

A `RunDivergence` raised inside a concurrency scope is no longer recorded as the scope's own outcome: `performScope`'s ladder rethrows it and settles nothing, so the scope entry stays pending and a resume re-enters it and diverges again at the step that broke, instead of replaying a recorded `L4000` scope-fault a program's `try`/`catch` can swallow. A divergence among a `race`'s settled arms is hoisted ahead of the winner scan beside a refused append and a held arm, so a losing arm's divergence is never discarded behind a winning sibling and the winner's value is never handed back over it.
