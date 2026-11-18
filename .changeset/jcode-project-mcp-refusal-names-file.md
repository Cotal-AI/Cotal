---
"@cotal-ai/connector-jcode": patch
---

A Jcode agent refused for project MCP configuration in its working directory now says which of `.jcode/mcp.json`, `.mcp.json` or `.claude/mcp.json` it found, and to start the agent in another directory. It used to point at the private Jcode logs, which never recorded the refusal. A home directory with Jcode's own `.jcode/mcp.json` is the common case.
