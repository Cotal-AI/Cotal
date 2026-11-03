---
"@cotal-ai/workspace": patch
---

`controlPs` and `resolveControlTarget` take a `readOnly` option. A read-only call resolves and connects
without the liveness sweep and never prunes a registry entry, so a client that polls its managers
leaves the registry as it found it.
