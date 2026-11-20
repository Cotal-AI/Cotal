---
"@cotal-ai/connector-core": patch
---

Move the mesh agent's outgoing messaging (channel send and its receipt, role anycast with its status and cancel, DM with peer resolution, and the reply correlation behind them) with `closeChannelNames` and `presenceReadCondition` out of `agent.ts` into an internal `agent-messaging.ts`. `MeshAgent` keeps a forwarder for each public member. The package surface is unchanged.
