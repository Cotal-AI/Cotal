---
"@cotal-ai/manager": patch
---

A user-mode lifecycle a manager released or lost is retired by the next start of that manager.

The manager records each user-mode lifecycle it provisions. A default stop leaves that record when it releases the seat, and the next start drives the same retirement a live exit uses. The record is removed when the retirement confirms, and a preserved lifecycle is left while a resume is still pending.
