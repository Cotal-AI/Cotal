---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal persona --server <address>` with an address that no registered space uses no longer turns the current folder into a catalog. Outside a project it listed an empty catalog for a space named `main`, and `persona create` wrote `.cotal/agents/<name>.md` into whatever folder you were in. It now refuses with `TARGET_NOT_FOUND` and writes nothing. In a project it still reads that folder's catalog, as launch does. `@cotal-ai/workspace` exports `isGenuineSpace` for this check.
