---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Report a focus-mode recall as incomplete (`droppedChannels`) instead of silently claiming an empty, complete window when the channel has `replay: false` or was joined only through a wildcard subscription. Previously an ack-dropped ambient message or `@mention` on such a channel was unrecoverable and `cotal_inbox` reported no loss.
