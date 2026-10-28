---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

The persona catalog is read by one function, `readPersonaCatalog` in core. The manager's catalog and the CLI's `cotal personas`, `cotal persona`, `cotal status` and completion all read through it, so a change to what a bad file or an unreadable directory reports lands once. An absent directory is still an empty catalog. A directory that exists and cannot be read throws from `readPersonaCatalog`; `listPersonaCatalog` and `cotal personas list` still report that as empty, and status and completion still name it.
