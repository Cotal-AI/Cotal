---
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/delivery": patch
---

A multi-space host (`auth-service --spaces`, `auth-service --callout-only --spaces`, `deliver --spaces`) opens its spaces' lanes together, and waits at most 30 s for any one of them: an open that hangs no longer holds back every later space in the manifest, the ready line, or the acknowledgment of a removal. The hung open keeps running and is not started again; its lane is taken when it settles, or closed if the space left the manifest or the host refused meanwhile. The ready line names such spaces as "still opening", apart from the ones being retried. The default startup refuses such a space at the deadline, as it refuses one that fails to open.
