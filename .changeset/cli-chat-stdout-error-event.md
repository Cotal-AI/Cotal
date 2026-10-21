---
"@cotal-ai/cli": patch
---

Handle writable output error events as well as failed write callbacks so stdio participant shutdown is not interrupted by an unhandled stream error.
