---
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

OpenCode connector: mirror each agent's session transcript to its per-agent `tr-<name>` channel, event-driven from the plugin's in-process bus events (`message.updated` / `message.part.updated` / `session.idle`) — parity with the Claude connector, with no per-turn session refetch. The `tr-<name>` channel convention is exposed through the `Connector` contract (`Connector.transcriptChannel`) so the manager can grant the agent's publish ACL without the channel literal living in `@cotal-ai/core`, and the manager forwards control-plane `capabilities` (`COTAL_CAPABILITIES`) so a manifest-spawned agent exposes the `cotal_spawn` / `cotal_persona` tools its creds already authorize. Adds an end-to-end smoke for the mirror (`smoke:opencode-transcript`).
