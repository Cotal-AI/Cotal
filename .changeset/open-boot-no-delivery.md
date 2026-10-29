---
"@cotal-ai/cli": patch
---

An open mesh no longer starts a delivery daemon in a root that still holds a static stack's account files. `cotal up --detach --open` there used to start one, report it as lost with `! control plane degraded:` and exit 1 while it was still running, and a refresh or a refused `cotal down --preserve-state` could start one too. `up` now decides by the mesh's mode, so that first open boot exits 0 with the broker and manager, and `cotal down` stops only those. A static or user-auth boot whose daemon exits during the boot still reports it lost and exits 1.
