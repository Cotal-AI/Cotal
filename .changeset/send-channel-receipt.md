---
"@cotal-ai/connector-core": patch
---

cotal_send still creates an unregistered channel, but the success receipt says when the name is new and names close matches, so a typo is not identical to a send into a known room.
