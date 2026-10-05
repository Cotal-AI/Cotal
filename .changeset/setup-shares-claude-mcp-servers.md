---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/cli": patch
---

First-run `cotal setup` now shares your own Claude Code MCP servers with the sessions Cotal spawns. It copies the user-scope servers from your Claude Code config into the cotal config's `connectors.claude.mcpServers` and names them in its output, so a spawned session has the tools you know plus the cotal tools. Before this, a spawned session loaded only the cotal server and setup never said why. With none to copy it writes an empty list, and a cotal config that already declares that list keeps it. A server with an `env` or `headers` value that is anything but `${VAR}` references is left out and named, because the cotal config keeps secrets only as `${VAR}` references. So is an entry no session can start, such as one with a missing or empty `command` or `url`, or one whose `command` is not a string. For a lighter seat, remove entries from the cotal config or spawn with `--share-tools none`. Connector setup providers gain an optional `mcpServers` action whose `seed` input the CLI binds to workspace's new `seedConnectorServers`, which writes under a lock so two setups run at once record one list. Core exports `readCotalConfigFile` and the `ConnectorShareSetupInput` type, and connector-core exports the `ENV_REFERENCE` pattern it already used.
