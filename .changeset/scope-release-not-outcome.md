---
"@cotal-ai/lang": patch
---

A host stop inside a concurrency scope no longer poisons the run. `shouldStop` returning a reason while the walker was inside `parallel` or `fanOut` settled the scope entry as a failure carrying the release's own text as an `L4000` scope-fault, and a resume with a healthy host then replayed that entry and threw. The one interruption the release mechanism exists to make safe permanently ended any run that happened to be inside a scope, while the identical stop at a sequential seam resumed cleanly. `RunReleased` now joins the classes a scope refuses to record as its outcome, so the scope stays pending and a resume re-enters and finishes it.
