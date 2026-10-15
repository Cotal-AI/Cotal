---
"@cotal-ai/connector-claude-code": minor
---

The Claude Code MCP server can now be hosted. `serveClaudeSession({ env, input, output })`, exported from `@cotal-ai/connector-claude-code/mcp`, serves one managed session over the streams it is given and reads its launch env only from `env`, so one process can serve several sessions. The subpath includes CommonJS declarations for TypeScript hosts. Direct stdio launches remain supported and also shut down on input closure; a failure in that teardown exits with code 1. Hosted teardown releases its input listeners, handles input EOF and transport closure, refuses input that ends during startup, and reports teardown failures without an unhandled rejection in the host.
