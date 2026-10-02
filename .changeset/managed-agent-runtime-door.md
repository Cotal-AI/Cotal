---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

Hosted runtime create and status for managed agents. Core adds the closed `manager-managed-agent-runtime-create` and `manager-managed-agent-runtime-status` kinds on the manager-service-authority transport, with parsers that refuse any unknown top-level or target field, including `providerRef`, `handle`, and `name`. Core also adds a result builder and binder whose `state`, `readiness`, and optional `retirementPhase` come from closed sets. The auth service adds `authorizeRemoteManagedAgentRuntimeCreate` and `authorizeRemoteManagedAgentRuntimeStatus`. Each applies the enrollment door's gate, epoch, and proof checks, reads `supervise` from the manager actor's own ledger row, and returns only `{ owner, instanceId, actor, target }`. The loopback verify-enrollment door serves both kinds, and stock dispatch refuses them with `unimplemented`. The manager client adds `remoteManagedAgentRuntimeRequest` and `remoteManagedAgentRuntimeState`. The enrollment result gains an optional, display-only `runtimeIntent: { state: "reserved" }`, which older hosts omit and the manager never treats as authority.
