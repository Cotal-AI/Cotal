---
"@cotal-ai/lang": patch
---

A scope that calls the handler is refused inside `once` by that trait, with L4028 before its entry begins, whether or not the scope has an effect kind of the same name. `conclave` was the only such scope, and the refusal named it literally, so a later scope that calls the handler would have run inside `once` and been dispatched again on resume.
