---
"@cotal-ai/connector-claude-code": minor
---

The Claude Code MCP server can now be hosted. `serveClaudeSession({ env, input, output })`, exported from `@cotal-ai/connector-claude-code/mcp`, serves one managed session over the streams it is given and reads its launch env only from `env`, so one process can serve several sessions. Running `node dist/mcp.cjs` is unchanged.
