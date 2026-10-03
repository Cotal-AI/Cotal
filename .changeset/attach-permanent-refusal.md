---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`ConnectRefusal` now carries a `kind`: `transient` when the broker could not be reached or answered too slowly, or no mesh is recorded yet, and `permanent` for every other refusal. A `cotal attach` that is reconnecting after its link died now exits non-zero with the refusal's own sentence when the refusal is permanent, such as a static-auth mesh whose seed has gone missing. It used to retry that forever behind `[cotal: connection lost, reconnecting]` with no explanation.
