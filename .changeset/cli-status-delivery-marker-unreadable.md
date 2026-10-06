---
"@cotal-ai/cli": patch
---

`cotal status` no longer exits 1 when the manager's delivery-aware marker cannot be read. The marker is read only for a live manager, and a failed read is named on the manager row as `delivery-aware marker unreadable` with the error, so the recorded meshes, the selected mesh and the `--components` pass still print. `cotal up` and the delivery preflight still refuse a marker they cannot read.
