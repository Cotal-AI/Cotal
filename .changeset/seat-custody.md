---
"cotal-ai": minor
"@cotal-ai/seat": minor
"@cotal-ai/manager": minor
---

Split Linux PTY ownership out of the manager worker: a one-shot launcher starts one detached custodian process per seat, and `Runtime.adopt` returns a live proxy over a permissioned Unix socket. Off Linux, pty spawn stays in-process and `adopt` throws a named custody-transport error.
