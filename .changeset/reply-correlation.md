---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-hermes": patch
---

Replies now carry their correlation, so an answer reaches the Hermes session that asked. A `cotal_dm` to a peer answers the newest DM that peer sent and that no DM back has answered yet: it names that message in `replyTo` and copies its `contextId` (SPEC §5). `MeshAgent.withCorrelation` stamps a `contextId` and `replyTo` on the sends one call makes. The Hermes bridge's `tool` frame takes an optional `contextId` and its `reply` frame an optional `replyTo` and `contextId`. The Hermes plugin stamps each Cotal session's `cotal_dm`, `cotal_send` and `cotal_anycast` with a `contextId` minted for that session and runs a DM carrying an issued one in that session, where it used to land in a session keyed by the replying peer. A turn's reply names the message it answers. Sessions on other gateway platforms are unchanged.
