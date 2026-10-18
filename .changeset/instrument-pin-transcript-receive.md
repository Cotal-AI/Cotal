---
"@cotal-ai/manager": patch
---

The instance-pin smoke's admin sweep now sends `transcript-receive` schema-valid nonsense arguments: a random digest, size 0, and session and host names that match nothing. It used to send `{}`, which the envelope refused on `required` before publishing, so the command never reached a responder and the cell that proves every admin command reaches the guard failed on every run. No behavior changes.
