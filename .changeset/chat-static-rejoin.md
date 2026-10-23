---
"@cotal-ai/cli": patch
---

A static `chat` session can `/join` a channel again after `/leave`. Leaving used to empty the
session's read list, so `/join` refused with a message saying the session was opened on no channel.
