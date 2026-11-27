---
"@cotal-ai/connector-claude-code": patch
---

A Claude conversation in T3 Code now stays reachable on Cotal after it goes idle. T3 Code and other Agent SDK hosts stop an idle session's Claude Code process (T3 Code after 30 minutes), which ended the plugin's connection, so later messages woke nothing. In such a session `cotal_connect` now asks Claude to start a silent hold with the Bash tool in the background. The host keeps a session with a running background task, and each hold ends after 3 hours, inside T3 Code's 4-hour limit, so Claude starts the next.
