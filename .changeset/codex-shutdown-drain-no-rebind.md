---
"@cotal-ai/connector-codex": patch
---

A Codex seat that stops while its event plane is armed but not yet bound to a rollout file no longer binds on the way out. A bind that resumes after the seat began stopping now stands down, whether it was looking for the file or reading where to start in it, and whether shutdown's own drain, the turn boundary from shutdown's interrupt, or the launch started it. The seat no longer logs another `no rollout file yet` line while it exits, and no longer adopts an emitter that nothing closes while it leaves the mesh.
