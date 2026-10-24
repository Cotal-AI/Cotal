---
"@cotal-ai/cli": patch
---

`cotal meshes` writes its list through the shared table, so a terminal too narrow for its columns gets one labeled record per mesh instead of a line that runs past the edge. The `current` default is marked `(default)` after its name instead of with a leading `*`.
