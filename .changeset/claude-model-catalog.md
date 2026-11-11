---
"@cotal-ai/connector-claude-code": patch
---

`cotal models` now lists the Claude Code models your login can use, read from your own `claude` without sending a prompt.

The connector asks `claude` with one `initialize` request over its stream-json control protocol, from an empty private directory with no MCP servers, no hooks and no saved session. When `claude` is missing, logged out, refuses or does not answer within 10 seconds, the catalog is reported unavailable with the reason instead of a list.
