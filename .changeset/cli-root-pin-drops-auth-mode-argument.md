---
"@cotal-ai/cli": patch
---

The `cotal up` root pin no longer takes an auth-mode argument. It already pinned the same way for auth and `--open` meshes and never read the argument, but every caller still worked out the mesh's auth mode to pass it, and the `-f` path parsed `broker.auth` only for that. Behavior is unchanged.
