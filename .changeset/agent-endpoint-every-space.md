---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/manager": minor
"@cotal-ai/acp": minor
---

Agents on static spaces and open meshes now answer their owner's prompts, commands, turns, interrupts, usage reads and renames, as they do where people sign in. A static `agent` credential now carries the serve rows for the `agent` endpoint and no caller row. A renewal keeps the rows its first issuance recorded, so an agent an older release started keeps running without the endpoint until it is respawned, and its connector says so. Core adds the static `agent-caller` profile: the owner's calls to the agents under its own owner, their replies and its inbox, never minted by the auth callout. `openAgentCaller` in `@cotal-ai/workspace` opens it. `CotalEndpoint.servePrincipal` and `MeshAgent` serve on every mesh mode. On an open mesh any client may call, outside the security claims. The Manager's `status.connectors[].prompts` is the connector's declaration on every mesh mode, with the same schema and cluster revision. Codex accepts an asking `approval_policy` on every space. `cotal acp` calls agents through an in-memory `agent-caller` on a static space and through its observer elsewhere, so questions, the agent's commands, images and `/name` work in a thread on every space. The Manager now accepts a spawn's `firstCommand` on static spaces and open meshes too, and the agent runs it there as its first turn.
