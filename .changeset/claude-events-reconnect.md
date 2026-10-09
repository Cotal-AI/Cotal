---
"@cotal-ai/connector-claude-code": patch
---

Keep MCP alive while event recording waits for an initial mesh connection or a reconnect. Resume queued event publication when both the mesh binding and transport recover, and cancel the wait on shutdown without weakening required-recording failures.
