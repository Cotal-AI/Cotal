---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Report the Cotal release a server actually loaded as its standard MCP `serverInfo.version`, instead of the placeholder `0.0.0`. The conversation gateway over HTTP and stdio and the managed Claude Code server now use the same value `cotal_orientation` shows, so a long-running server keeps reporting the release it loaded rather than whatever is installed on disk now.
