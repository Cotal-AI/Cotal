---
"@cotal-ai/connector-claude-code": patch
---

Keep the Claude Code connector's MCP server answering in a plain session. With no `COTAL_NAME`, `COTAL_LINK` or `COTAL_AGENT_FILE` it used to exit before `initialize`, so every plain `claude` with the plugin installed showed `Connection closed` and an MCP introspection check such as Glama's saw no tools. It now serves one static `cotal_how_to_join` tool over stdio and still stays off the mesh: no mesh agent, no broker connection and no control socket.
