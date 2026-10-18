---
"@cotal-ai/manager": patch
---

A manager spawn now resolves its `shareTools` selection when it reads the cotal config, before it accepts the spawn. A selection naming a server the connector does not declare used to be refused only after the spawn was accepted and provisioned, so the caller saw an acceptance, and a hosted run bound a goal, for a request that could never launch. The refusal text is unchanged.
