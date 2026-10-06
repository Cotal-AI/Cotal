---
"@cotal-ai/connector-opencode": patch
---

An OpenCode agent launch no longer fails with `ENOENT` when the previous launch of the same agent removes its `serve.pid` record while the new launch is checking it. The launcher now reads the record once, treats a record that is gone as no record, and removes a dead one without failing if it has already been removed.
