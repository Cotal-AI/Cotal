---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

Report harness work timestamps across the Claude Code, Codex, Hermes, OpenCode and pi connectors.

Relay work events into the existing presence `activeAt` field so roster and operator surfaces can date the last reported work separately from heartbeats. No new wire field or progress verdict is added. Boundary-only hosts report less frequently than streaming hosts, and work age cannot distinguish a slow provider from a hung one.
