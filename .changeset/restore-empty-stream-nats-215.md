---
"@cotal-ai/cli": patch
---

`cotal backup restore` and `cotal up --restore` no longer refuse a space with an empty stream when the broker is nats-server 2.15. That server restores a never-written stream as exhausted (`first_seq` 1) rather than initial (`first_seq` 0). The restore check now compares an empty stream by its last sequence alone, which both forms share.
