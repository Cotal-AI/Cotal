---
"@cotal-ai/connector-core": patch
---

Move the mesh agent's channel members (channel briefing, readable set, channel info, channel listing, join and leave) and `isLocalServer` out of `agent.ts` into an internal `agent-channels.ts`. `MeshAgent` keeps a forwarder for each public member. The package surface is unchanged.
