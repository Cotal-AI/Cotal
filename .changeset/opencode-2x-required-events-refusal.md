---
"@cotal-ai/connector-opencode": patch
---

The OpenCode 2.x connector refuses a session whose registration requires events, through the same arming decision the other connectors use. It refused only when `COTAL_EVENTS` was set, so launch material carrying `eventsRequired`, or `COTAL_EVENTS_REQUIRED=1` on the user-mode env fallback, started a session with no event plane on a space that requires one.
