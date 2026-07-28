---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

`cotal spawn -f` now deploys to a remote manager: when the mesh's serving manager lives in another checkout or on another host, the resolved launch spec rides the `launch` control op inline — the manager validates it with the same untrusted-input contract as the file path and persists it under its own `.cotal/run/` (stale-restart and retained resume read one source either way). The ledger stays with the deploying checkout, so `down -f` works from there too. Also fixes a pre-existing re-apply edge: the transient persona file is now written atomic-replace instead of exclusive-create, so re-launching an agent after a partial deploy failure no longer dies on EEXIST.
