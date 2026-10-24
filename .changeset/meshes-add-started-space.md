---
"@cotal-ai/cli": patch
---

`cotal meshes add` now refuses a name that is prepared on this machine, or that this machine started or a catalog lists, with or without `--force`, as `cotal space add` does. Replacing that registration left a running stack that `cotal down` could no longer find. The guided form no longer offers to replace it either.
