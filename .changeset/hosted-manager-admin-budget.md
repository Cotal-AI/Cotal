---
"@cotal-ai/auth": patch
---

Hosted manager reads refuse promptly when their authorization dependencies stall.
One five-second budget covers token acquisition, the authority request and response-body
completion. Pending HTTP work is aborted without cancelling other callers' token reads,
and no stale authorization is reused.
