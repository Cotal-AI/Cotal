---
"cotal-ai": patch
"@cotal-ai/manager": patch
---

Remove abandoned Manager registrations when a computer returns after its space was removed.
The daemon uses the governing authority's ownership and broker-liveness guard after stopping
its child. Unsupported, refused or unconfirmed cleanup remains visible in daemon status with
the recorded instance and a recovery command, without hosting the removed space again.
Explicit disconnection still closes the machine service and forgets its connection intent when
Manager registration cleanup cannot complete.
Failed attempts to re-enable hosting retain an unconfirmed cleanup fence across restarts, so they
cannot cause another registration removal request before a successor Manager answers.
