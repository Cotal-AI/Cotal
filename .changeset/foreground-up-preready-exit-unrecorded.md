---
"@cotal-ai/cli": patch
---

A foreground `cotal up` whose nats-server exits before it serves says the mesh is not recorded. Before, it said the mesh stayed recorded and that `cotal meshes` listed it offline, and gave a repair command, although nothing had recorded it and `cotal meshes` listed nothing.
