---
"@cotal-ai/connector-codex": patch
---

A Codex seat that stops while its event plane is armed but not yet bound to a rollout file no longer binds on the way out. A look for the file that returns after the seat began stopping now stands down, whether shutdown's own drain started it, the turn boundary from shutdown's interrupt started it, or the launch was still looking. The seat no longer logs another `no rollout file yet` line while it exits, and no longer adopts an emitter that nothing closes while it leaves the mesh.
