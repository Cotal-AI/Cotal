---
"@cotal-ai/cli": patch
---

`cotal meshes rm --force` no longer drops the record of a mesh this machine is running. Dropping it left a running stack that `cotal down` could no longer find, so `rm` now refuses with or without `--force` and points at `cotal down`, which stops the mesh and drops the record. `--force` still drops a record whose folder cannot be checked for a running mesh.
