---
"@cotal-ai/connector-claude-code": patch
---

A Claude conversation in T3 Code now stays reachable on Cotal for as long as it is open, not only for the first 30 idle minutes. Claude Code stops a background command after 30 minutes unless it is given a longer timeout, at most 2 hours, so the hold now asks for the 2-hour timeout and ends by itself after 110 minutes with a line that asks Claude to start the next one. Claude did not always start a hold when asked, so while a conversation has a Cotal connection and no hold running, the plugin's Stop hook now keeps its turn going until it starts one. The hold takes the conversation's session id (`monitor.cjs --hold <session>`).
