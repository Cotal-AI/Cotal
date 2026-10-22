---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Explain the native data sharing a person approves: new user messages, assistant replies, tool inputs and tool results are published to readers permitted by the space's activity policy. Reasoning is off by default, and history from before approved activation is not shared. Correct the event-plane documentation's old transcript-boundary description. No event behavior or permission is changed.
