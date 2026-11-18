---
"@cotal-ai/connector-claude-code": patch
---

A Claude spawn now refuses an initial prompt or a resume session id that starts with `-`. Claude reads a leading argument that starts with `-` as an option, so the connector refuses the launch with a message naming the rule and starts nothing. A prompt with a `-` anywhere else is delivered unchanged.
