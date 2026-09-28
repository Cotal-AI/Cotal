---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A `--config` spawn now records the persona's identity name as its preservation ref instead of the config path, and a preservation prepare that later refuses aborts the manager's attempt and clears the prepare intent so the mesh stays usable for the next `down --preserve-state`.
