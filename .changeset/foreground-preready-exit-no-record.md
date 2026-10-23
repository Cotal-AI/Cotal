---
"@cotal-ai/cli": patch
---

A foreground `cotal up` whose broker exits before it serves no longer reports a mesh record that was never written. A fresh mesh is recorded only once its broker answers, but every unrequested exit printed that the mesh "stays recorded (`cotal meshes` lists it offline)" with a repair command, and `cotal meshes` then listed nothing. `up` now reads the registry when the broker exits. With no record for this space, server and root it says the broker exited before the mesh was recorded and names the log. A record that does exist, such as one kept from an earlier start, is still reported as kept with its repair command.
