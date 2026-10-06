---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

A seat whose AG-UI event plane stops for good now follows the space's policy on every connector. On a space that requires events the seat stops, where Pi, Claude Code and OpenCode used to keep it running without events. On any other space the seat keeps running and its log records `AG-UI emitter stopped`, where Jcode used to stop the seat and refuse further turns. Codex no longer rebuilds a stopped plane at its next turn boundary on any space, and it now waits for the mesh before starting its emitter, as the other connectors do. The rule is `eventPlaneStopped` in connector-core, which each connector passes its log sink and its stop hook.
