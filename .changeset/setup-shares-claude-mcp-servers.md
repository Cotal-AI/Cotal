---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/cli": patch
---

First-run `cotal setup` now shares your own Claude Code MCP servers with the sessions Cotal spawns. It copies the user-scope servers from your Claude Code config into the cotal config's `connectors.claude.mcpServers` and names them in its output, so a spawned session has the tools you know plus the cotal tools. Before this, a spawned session loaded only the cotal server and setup never said why. A cotal config that already declares that list keeps it. A server whose `env` or `headers` hold a literal value is left out and named, because the cotal config keeps secrets only as `${VAR}` references. For a lighter seat, remove entries from the cotal config or spawn with `--share-tools none`. Connector setup providers gain an optional `mcpServers` action, core gains `seedConnectorServers`, and connector-core exports the `ENV_REFERENCE` pattern it already used.
