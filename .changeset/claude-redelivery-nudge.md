---
"@cotal-ai/connector-claude-code": patch
---

A Claude Code seat no longer re-prints the wake nudge for a DM it already announced each time JetStream redelivers that DM. While one long tool call kept the hook drain from running, an unacked DM was redelivered every 60s and every copy queued another identical "New dm" notice, so a 51-minute call left about 50 of them per message. The connector now nudges once per message until a hook frame carries it, and a redelivery after a frame whose reply never reached Claude Code still nudges again.
