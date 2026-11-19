---
"@cotal-ai/connector-core": patch
---

An empty `cotal_wait` on a connection that cannot hear from the broker no longer returns the plain "No new messages" reply. It opens with the connection warning `cotal_inbox` gives and says only the local buffer was read. A connected wait keeps the plain reply.
