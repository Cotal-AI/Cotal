---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

A run on the compiled engine no longer reports a value the program threw as a host hold or release. The worker thread used to copy `code`, `reason`, `step` and `kind` off whatever was thrown, and the host rebuilt `RunHeld` or `RunReleased` from the code alone, so `throw { code: "L5025", reason: "..." }` came back as a held run with the placeholder step `(step not carried)`, and `throw { code: "L5012", ... }` as a release. Both now fail as the plain value they are, as they do on the walker. `WorkerRunFailed` is now a union discriminated by `class` (`released`, `held`, `effect`, `too-large`, `rejected` or `error`). The thread picks the variant with `instanceof`, each variant requires its class's fields, and the host rebuilds the class with no defaults. `tooLarge` is replaced by the `too-large` variant's `stepKey`, `bytes` and `bound`. This breaks code that calls `runInWorker` itself: `code` now crosses only on the `effect` and `error` variants, so a caller that branched on `L5012`, `L5025`, `L5006` or `L5010` branches on `class` instead.
