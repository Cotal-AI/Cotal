---
"@cotal-ai/connector-core": patch
---

Use core's existing peer-label sanitizer for attribution fields. Channel and kind framing now neutralize all C0/C1 controls consistently with roster labels, while preserving ordinary Unicode, spacing and the existing bracket/line-break handling.
