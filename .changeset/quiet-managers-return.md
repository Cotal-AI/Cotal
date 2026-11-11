---
"cotal-ai": patch
"@cotal-ai/manager": patch
---

Remove abandoned Manager registrations when a computer returns after its space was removed.
The daemon uses the governing authority's ownership and broker-liveness guard after stopping
its child. Unsupported, refused or unconfirmed cleanup remains visible in daemon status with
the recorded instance and a recovery command, without hosting the removed space again.
