---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

The CLI and the manager now list the persona catalog through one reader in core, so `cotal personas`, `cotal persona`, `cotal status`, spawn completion and a peer's `cotal_personas` read one catalog the same way. The manager's listing gains what the CLI's own copy already did: a persona file that is a FIFO or another non-regular file is listed as unreadable rather than opened, so the listing no longer waits on it. Core exports `readPersonaCatalog`, which throws for a catalog folder that exists and cannot be read, and `linkTarget`. A `PersonaCatalogEntry` carries `encoding`, `notRegular` and `link`.
