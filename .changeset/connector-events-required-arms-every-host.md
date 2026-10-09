---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

The Codex and Jcode hosts now arm the event plane when the session's registration requires events, even without `COTAL_EVENTS`. They used to read only that flag, so a hand-driven user-mode launch with `COTAL_EVENTS_REQUIRED=1`, or a custom launcher that passed `eventsRequired` with events opted out, ran with no event plane and the required-events policy never applied. The Claude, OpenCode, Codex, Jcode and Pi launches that carry `eventsRequired` now also set `COTAL_EVENTS` and the workspace root when the launcher passed `events: false`, so the armed session has a place for its event log. Both decisions go through `launchArmsEvents` and `eventPlaneArmed` in `@cotal-ai/connector-core`; an OpenCode 2.x session still reads only `COTAL_EVENTS`.
