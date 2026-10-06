---
"@cotal-ai/core": minor
"@cotal-ai/connector-claude-code": minor
---

The cotal config reader now refuses a shared MCP server that cannot launch as written, naming the file and the field (`cotal config <path>: connectors.<name>.mcpServers.<server>.<field> must be ...`). A wrong-typed `command`, `type`, `url`, `args`, `env` or `headers` used to pass the reader and fail every Claude spawn with a bare `TypeError` that named neither, and a server with no transport to start (no `command` for stdio, no `url` for http, sse or ws, or any other `type`) was forwarded to `claude` and silently never loaded. `cotal setup` copies a server from the Claude config by the same check. A config file that holds such a server now refuses every spawn until it is fixed; `docs/UPGRADING.md` lists what to check before upgrading.
