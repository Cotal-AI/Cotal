---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A foreground `cotal up` whose broker exits on its own now exits 5 instead of passing on the broker's
exit code, which read as a usage error, or 1 for a broker ended by a signal. A broker that exited 0,
as after an external `down`, still exits 0. Its line says the mesh stays recorded only when the
registry holds that broker's record, so a broker that exits before the mesh was recorded no longer
claims a record `cotal meshes` does not list.
