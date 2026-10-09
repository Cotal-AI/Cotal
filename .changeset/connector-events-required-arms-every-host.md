---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

The Codex and Jcode hosts now arm the event plane when the session's registration requires events, even without `COTAL_EVENTS`. They used to read only that flag, so a hand-driven user-mode launch with `COTAL_EVENTS_REQUIRED=1`, or a custom launcher that passed `eventsRequired` with events opted out, ran with no event plane and the required-events policy never applied. Every connector now makes this decision through one `eventPlaneArmed` helper in `@cotal-ai/connector-core`.
