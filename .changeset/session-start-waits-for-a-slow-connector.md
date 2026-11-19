---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

A Claude Code seat whose connector started more than two seconds after the session no longer publishes nothing on the event plane for its whole session. The `SessionStart` hook at launch now keeps dialing the connector's control socket for up to 30 seconds, the time Claude gives an MCP server to connect, instead of giving up at two seconds and losing the only event that says where the transcript starts. A clear or a compaction keeps the two-second budget, and later hooks still fail open at once.
