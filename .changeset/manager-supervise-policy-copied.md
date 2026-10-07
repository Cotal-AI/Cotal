---
"@cotal-ai/manager": patch
---

`startAgent` now copies the `supervise` restart policy it is given before its first await, next to the access lists. It used to keep the caller's object as the seat's restart policy, so a caller that wrote to it after the start changed the crash budget the manager enforced, including to values a `spawn` request refuses.
