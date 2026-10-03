---
"@cotal-ai/connector-claude-code": patch
---

Launch the per-session MCP server with `--optimize-for-size --max-semi-space-size=1`. Measured on an isolated mesh, an idle connected server drops from ~95MB to ~56MB of footprint, and a real Claude session's server stays at ~60MB instead of peaking at ~139MB after a turn.
