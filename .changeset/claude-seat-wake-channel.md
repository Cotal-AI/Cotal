---
"@cotal-ai/connector-claude-code": minor
"cotal-ai": minor
---

A managed Claude Code seat wakes on peer messages again. Claude Code binds the `server:cotal` wake channel only to a server its own configuration declares, the user config or the project's `.mcp.json`, and never to the launch's `--mcp-config` entry alone; a seat launched without one joined the mesh, reported idle and let every turn and direct message expire. `cotal setup` and `cotal update` now register the plugin's server as the user-scope MCP entry `cotal` (`claude mcp add --scope user`, the same command and arguments as the plugin's own server, so a plain session runs one process), a carried seat's private home declares it, `cotal status` reports it under `Claude wake channel`, and a managed launch whose user config and project `.mcp.json` declare no `cotal` server is refused with a message naming `cotal setup`. Run `cotal update` on each machine that spawns Claude seats; `docs/UPGRADING.md` has the details.
