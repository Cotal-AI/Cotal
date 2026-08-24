---
"@cotal-ai/connector-jcode": patch
---

Stabilize Jcode startup around asynchronous MCP registration: retry the mandatory orientation proof once, preserve loud refusal when it remains unavailable, open the foreground TUI during readiness, and clarify that the bootstrap orientation predates mesh join.
