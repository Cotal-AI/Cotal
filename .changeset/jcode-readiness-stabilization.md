---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
---

Stabilize Jcode startup around asynchronous MCP registration: retry the mandatory orientation proof once, preserve loud refusal when it remains unavailable, open the foreground TUI during readiness, and issue the stale-orientation notice only after a completed mesh join.
