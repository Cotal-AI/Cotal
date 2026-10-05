---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal ext add` now reports an extension that needs an export its linked `@cotal-ai/*` peer does not have the way a later load of it does: it names which install is behind and what to rebuild or upgrade. It used to print only the raw missing-export import error. First-run and upgrade seeding add every built-in connector through this path.
