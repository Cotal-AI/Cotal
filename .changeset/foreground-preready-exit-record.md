---
"@cotal-ai/cli": patch
---

A fresh foreground `cotal up` whose nats-server exits before it serves now says the mesh is not recorded. It used to say the mesh stays recorded and that `cotal meshes` lists it offline, though nothing had been recorded, and its repair hint repeated the command that had just failed. A broker that exits after the mesh is recorded still keeps its record and prints the repair hint.
