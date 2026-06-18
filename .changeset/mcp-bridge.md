---
"@cotal-ai/mcp-bridge": minor
"@cotal-ai/connector-core": minor
---

Add an MCP-bridge endpoint: connect to an MCP server once and serve its tools to the whole
space over the control plane (`list`/`call` on the `mcp` service). Supports local stdio servers
and remote HTTP/SSE servers, with static bearer/header auth or full interactive OAuth
(`cotal mcp-bridge login`). Coding agents opt in via `COTAL_MCP_BRIDGE=1` to get the
`cotal_tools` / `cotal_tool` tools.
