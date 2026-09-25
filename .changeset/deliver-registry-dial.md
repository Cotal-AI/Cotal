---
"@cotal-ai/delivery": patch
---

`cotal deliver` now resolves the broker for `--space` through the mesh registry: a registered space is dialed at its recorded broker (with the record's TLS requirement), a mismatching `--server` or a record for another workspace root is refused before any dial, and an unreachable recorded broker is reported with its URL and the remedy that fits the record's origin. Spaces with no record keep the local-mesh default, and the hosted (injected-store) daemon still learns its target from argv alone.
