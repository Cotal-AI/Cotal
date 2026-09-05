---
"cotal-ai": minor
"@cotal-ai/seat": minor
"@cotal-ai/manager": minor
---

Split Linux PTY ownership out of the manager worker: a one-shot launcher starts one detached custodian process per seat, and `Runtime.adopt` returns a live proxy over a permissioned Unix socket. Other platforms throw a named custody-transport error. There is no in-process fallback.
