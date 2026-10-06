---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Applying a space catalog (`cotal sync` and the lazy catalog refresh) now reads the mesh registry a fixed number of times instead of once or twice per catalog row. Each row reads only its own record file just before writing it, so a registration that `cotal meshes add` or `cotal up` records while the catalog applies still wins its collision check, and the records and the removals each share one legacy-file sweep, so the time spent under the catalog lock grows linearly with the registry. The workspace package adds `readMesh`, which reads one space's record file, and `recordMeshes` and `removeMeshes`, the batch forms of `recordMesh` and `removeMesh`.
