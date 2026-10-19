---
"@cotal-ai/cli": patch
---

`cotal status --components` now reads each component's process record through the shared pidfile read. It kept its own copy of that read, so the change that names the record's path in a read error reached bare `cotal status` and never reached the components rows: a directory at `.cotal/web.pid` read `refused · pidfile unreadable: EISDIR: illegal operation on a directory, read` with no path. The row now reads `refused · pidfile unreadable: cannot read <path>: <reason>`, the same error the bare row names, and a missing or empty record still reads as `absent`.
