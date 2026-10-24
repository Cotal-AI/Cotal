---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A `COTAL_HOME` that names a file, or a path under one, now stops every command except help and shell completion with `SCHEMA_INVALID`, naming the variable and the fix: point it at a directory or unset it. `space create` used to report an unconfirmed outcome with the raw `ENOTDIR` error, and `status` printed that error several times.
