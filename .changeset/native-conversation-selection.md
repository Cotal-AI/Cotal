---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
---

A signed-in native Claude Code conversation can now ask for channels, a role and capabilities within the person's own grant.

`cotal_connect` in a native Code session takes `channels` (read, or read and post), a `role` and `capabilities` (`spawn`, `run`). Each item must already be within your own grant. When one is not, nothing is issued and the reply names every refused item; there is no fallback to the event-only identity. The issued grant must match the selection item for item, or the connection is refused. A remote mesh must advertise conversation identity selection v1 first. Endpoint selection is not available in v1, because no stock credential yet carries endpoint caller reach for a conversation.

A connection is offered the tools its own grant can use: spawn, despawn and the persona tools with `spawn`, `cotal_run` with `run`, and `cotal_reconnect`. Manager calls exchange the conversation's own secret for a manager-call view. A conversation is not a managed seat, so a self-despawn refuses instead of stopping the app, and `cotal_yield` is not offered.

Core exports `conversationSelection`, `checkConversationSelection` and `conversationGrant`. The gateway gains `NATIVE_GATEWAY_TOOLS`, `GatewayOptions.tools`, `GatewayOptions.selection` and `GatewayConnection.tools`. `cotal app-identity provision` takes `--selection <json>`. The hosted gateway's tool set is unchanged.
