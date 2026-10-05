---
"@cotal-ai/connector-claude-code": patch
---

The Claude Code connector now leaves the mesh when its stdin closes. An MCP client closes the server's stdin to end the session, and a killed `claude` closes it without firing `SessionEnd`. The connector used to keep running after either, held open by its mesh connection, so it kept heartbeating presence and every peer's `cotal_roster` showed the dead session as a live peer indefinitely. It now stops on stdin end as it does on SIGTERM, publishing `offline` before it exits.
