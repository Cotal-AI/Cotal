---
"@cotal-ai/runtime": patch
---

Move the mesh handler's `spawn` action (cwd resolution, the worktree claim and release, the submission and its terminal await, and `spawnArgs`) out of `mesh-handler.ts` into an internal `mesh-spawn.ts` component that reads the handler's members through its dependencies. The package surface is unchanged.
