---
"@cotal-ai/connector-opencode": patch
---

The OpenCode connector's AG-UI emitter now waits for the mesh link before it starts. The shim creates
the native session before the plugin's endpoint binds, the emitter started from that first event
against an endpoint that had not started, and its holder failed terminally, so every armed OpenCode
session published nothing for its whole life with one stderr line as the only record. The emitter
now awaits the same bounded connection wait the Claude Code connector takes, and past its window it
fails into the holder's terminal error rather than hanging the event handler.
