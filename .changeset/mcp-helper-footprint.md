---
"@cotal-ai/connector-claude-code": patch
---

Shrink the per-session MCP server. It now launches with `--optimize-for-size --max-semi-space-size=1`, and its bundles are emitted as pure ASCII, so node holds the 4.2MB source one byte per character instead of 8.2MB two-byte. Measured on an isolated mesh, an idle connected server drops from ~95MB to ~53MB of footprint, and a real Claude session's server stays at ~60MB instead of peaking at ~139MB after a turn.
