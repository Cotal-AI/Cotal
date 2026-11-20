---
"@cotal-ai/connector-core": patch
---

Move the mesh agent's manager-facing commands (spawn, model inspection, manager endpoint listing, despawn, run, persona define/list/show, history purge) and `SPAWN_TIMEOUT_MS` out of `agent.ts` into an internal `agent-supervision.ts`. `MeshAgent` keeps a forwarder for each public command. The package surface is unchanged.
