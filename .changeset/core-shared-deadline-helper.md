---
"@cotal-ai/core": patch
---

The endpoint credential reload, the membership feed's rw credential reload and the backup snapshot sink now share one promise deadline helper instead of three hand-copied races. Timeouts, error types and messages are unchanged.
