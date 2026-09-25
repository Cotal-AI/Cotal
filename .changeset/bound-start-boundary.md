---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-opencode": patch
---

Capture the event plane's start boundary at adopt instead of at the emitter's first read, so a complete record written while the connector is still starting up (the mesh wait, log open, and preflight) is no longer silently dropped. Claude Code and OpenCode both wrap their session source with the shared `BoundStartSource`.
