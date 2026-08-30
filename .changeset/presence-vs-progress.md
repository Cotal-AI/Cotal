---
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

Stop answering progress with presence. Textual working rows without an outside last-assistant observation render progress unknown, while heartbeat age remains explicitly labelled as liveness. The render-agnostic observation classifier lives in the workstation layer, not protocol core; compact presence-only glyphs make no progress claim. A stale observation overlays stalled Xm on still-fresh presence.
