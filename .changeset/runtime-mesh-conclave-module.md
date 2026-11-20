---
"@cotal-ai/runtime": patch
---

Move the mesh handler's conclaves (planning, executing and releasing a conclave, and the channel, members and ACL registry handles they share) out of `mesh-handler.ts` into an internal `mesh-conclave.ts` component that owns the open conclave plans and the registry handles. The package surface is unchanged.
