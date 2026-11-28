---
"cotal-ai": patch
---

`cotal daemon setup` now reports `service: <unit> is already installed` instead of claiming the unit was left as it is, prints `service: updating <unit> pinned PATH` immediately before rewriting an installed POSIX service's `PATH`, and prints `service: restarted <unit> with the updated PATH` only after the service restart completes.
