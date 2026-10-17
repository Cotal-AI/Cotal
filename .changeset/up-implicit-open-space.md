---
"@cotal-ai/cli": patch
---

A bare `cotal up` in the root of an open mesh started with `--space <name>` now runs that mesh. It
used to resolve the default space from the folder's auth accounts, which an open mesh does not
have, and refuse with advice to drop a `--space` that was never passed. Every lookup in the boot
now uses that one resolved space.
