---
"@cotal-ai/connector-core": patch
---

Move the mesh agent's own presence writes (status with its turn-boundary yield, activity, condition, model and cwd, and the chain that keeps them in call order) out of `agent.ts` into an internal `agent-presence.ts`. `MeshAgent` keeps the status it reports and a forwarder for each member called from outside the family. The package surface is unchanged.
