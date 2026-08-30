---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

Stop answering progress with presence. A working roster row without an outside last-assistant observation renders progress unknown. A stale observation overlays stalled Xm on the still-fresh presence status.
