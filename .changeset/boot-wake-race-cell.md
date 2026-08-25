---
"@cotal-ai/connector-claude-code": patch
---

Add an end-to-end regression cell for the connector's boot lost-wake window: a peer message that buffers before the `claude/channel` handshake activates must still wake the session with no human turn. It drives the shipped wake policy against a real broker in `mcp.ts`'s own order and pins both halves of the property — that activation itself performs no reconcile, and that the durable redelivery re-announce is what recovers the dropped wake. Test-only; a mutation config grades the cell against removal of the re-announce.
