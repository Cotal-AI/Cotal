---
"@cotal-ai/cli": patch
---

Move the status command's mesh and selected-space readers out of `status.ts` into an internal `status-meshes.ts`. `status.ts` keeps every name it exported before, so the module surface is unchanged.
