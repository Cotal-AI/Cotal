---
"@cotal-ai/manager": patch
---

Export `ManagerInstanceLeaseHeld`, the typed error `Manager.start()` throws when this instance's lease is held by another live process on this root or by a holder on another root. It carries the held lease row and `sameRoot`, so an embedder no longer parses the message, which is unchanged.
