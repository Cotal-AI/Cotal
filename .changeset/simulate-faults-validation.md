---
"@cotal-ai/runtime": patch
---

A simulation results script with a fault entry that names no step, or carries a field the reader does not know, is now refused before the simulation runs instead of simulating as if the fault were not there.
