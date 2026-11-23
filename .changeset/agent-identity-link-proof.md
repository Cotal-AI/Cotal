---
"@cotal-ai/core": patch
---

Core can mint a stable agent identity and check that a relaunched run holds that identity's continuity key. `mintAgentUid`, `mintedAgentIdentity`, `signAgentLink` and `decideAgentLink` define the `agentid.<agentUid>` record and its link proof; nothing stores or sends them yet.
