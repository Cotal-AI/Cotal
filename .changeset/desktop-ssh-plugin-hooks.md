---
"@cotal-ai/connector-claude-code": patch
---

The `cotal` Claude Code plugin's manifest now names its hooks file. Claude Desktop copies a laptop's enabled plugins to an SSH host without their hooks and with the laptop's absolute Node path, and that copy overrides the host's own install, so a Desktop SSH session started Cotal's MCP server with a path that does not exist on the host and never ran its hooks. Desktop skips copying a plugin whose manifest names its hooks file, so the host's own install, set up by `cotal setup` on the host, now runs with its hooks. Local sessions are unchanged: Claude Code loads the named hooks file once.
