---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal history --dms` warns when the direct-message stream is not on the broker and reports a partial read. Channel history is still shown. A missing stream is no longer reported as a complete history with no direct messages.
