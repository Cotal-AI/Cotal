---
"@cotal-ai/workspace": patch
---

A process record that exists but cannot be read now fails with an error that names its path. `readPidfile` passed the underlying read error through unchanged, and an error raised at the read, such as `EISDIR` for a directory at `.cotal/nats.pid`, carries no path, so `cotal down` printed only `EISDIR: illegal operation on a directory, read`. The error now reads `cannot read <path>: <reason>` and keeps the original as its `cause`. A missing record still reads as absent.
