---
"@cotal-ai/core": patch
---

Compiling a contract no longer writes a process-CPU timing note to the embedder's stderr. The reading summed every thread in the process, so it could not say what the compile itself cost, and the structural bounds are what admit a schema. `SCHEMA_PROFILE` no longer carries `compileBudgetMs`, which only fed that note.
