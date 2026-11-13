---
"@cotal-ai/core": patch
---

`cotal channel remove --purge` removes a channel's saved entry when the chat stream is already gone. The receipt says 0 messages were purged instead of reporting the change as unconfirmed.
