---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A foreground `cotal up` whose broker exits before the mesh is recorded now says the broker exited
before the mesh was recorded. Its next step is the one a detached start gives: read the output
above, fix a `nats-server` found on PATH or take it off PATH, and run `cotal up` again. It no longer
offers the same `up` as a repair, which only repeated the exit. A broker that exits after its mesh
was recorded keeps the line that says the mesh stays recorded and names the repair `up`.
