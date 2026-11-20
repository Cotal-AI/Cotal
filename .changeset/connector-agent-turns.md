---
"@cotal-ai/connector-core": patch
---

Move the mesh agent's run turns (native participation lease, turn relay and pull, turn surfacing, once-task claims and reports, and the yield) with their module helpers out of `agent.ts` into an internal `agent-turns.ts`. `MeshAgent` keeps the turn state suites reach into and a forwarder for each member called from outside the family. The package surface is unchanged.
