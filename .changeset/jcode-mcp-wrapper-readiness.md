---
"@cotal-ai/connector-jcode": patch
---

Jcode seats join again on Jcode 0.99.1 and later. Those releases renamed the deferred MCP tool from `mcp_call` to `mcp`, and the readiness check did not count a `cotal_orientation` call made through it, so every launch failed after two readiness turns.
