---
"@cotal-ai/connector-claude-code": patch
---

Interrupting a Claude Code seat now also stops a foreground command when a prompt sent during the turn was still waiting. Before, that command kept running in the background.
