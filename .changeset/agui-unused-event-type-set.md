---
"@cotal-ai/connector-core": patch
---

Remove the unused `KNOWN_AGUI_EVENT_TYPES` set from the AG-UI module. Its doc comment described a classification role that `parseAguiFrame` already plays without it. The egress-guard differential cell that carried its name now says it counts the event types `AGUI_EVENT_TYPE` defines.
