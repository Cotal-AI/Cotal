---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
---

A signed-in native Claude Code conversation can now ask for channels, a role and capabilities within the person's own grant.

`cotal_connect` in a native Code session takes proposed `channels` (read, or read and post), a `role` and `capabilities` (`spawn`, `run`). The person must review, edit and approve the permissions in Cotal before a new connection is issued. The approved set must stay within their current access, and the returned grant must match that approved set, not the proposal. Unsupported or refused requests never fall back to baseline or broader access. A remote mesh must advertise selection v1 and connection approval v1. The authority may refuse a capability it does not support; endpoint selection is unavailable in v1.

A connection is offered the tools its own grant can use: spawn, despawn and the persona tools with `spawn`, `cotal_run` with `run`, and `cotal_reconnect`. Manager calls exchange the conversation's own secret for a manager-call view. A conversation is not a managed seat, so a self-despawn refuses instead of stopping the app, and `cotal_yield` is not offered.

Core exports `conversationSelection`, `checkConversationSelection` and `conversationGrant`. The gateway gains `NATIVE_GATEWAY_TOOLS`, `GatewayOptions.tools`, `GatewayOptions.selection` and `GatewayConnection.tools`. `cotal app-identity provision` takes `--selection <json>`. The hosted gateway's tool set is unchanged.
