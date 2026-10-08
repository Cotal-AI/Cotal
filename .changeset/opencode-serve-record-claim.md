---
"@cotal-ai/connector-opencode": patch
---

Two overlapping launches of one OpenCode agent name no longer both start a server on the agent's database. A launch now claims the agent by creating the next numbered record under `.cotal/opencode/<name>/claims/` with an exclusive create, which replaces `serve.pid`, and only while the newest record names no live launcher or server. No record is removed while it is the newest, so a launch that recovers a dead record at the same moment as another, or a launcher whose server exits late, can no longer free a newer launch's claim.
