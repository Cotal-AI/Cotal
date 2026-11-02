---
"@cotal-ai/cli": patch
---

`cotal meshes rm` now resolves all requested space names from a single registry load, removes the accepted records in one `removeMeshes` batch call, and reads the `current-mesh` pointer once for the batch instead of once per name. Each completed removal is reported and its selection cleared before the next removal, so a later filesystem failure cannot hide earlier progress.
