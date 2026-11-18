---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
---

A workflow `wait(message(channel, { from }))` now matches only messages whose subject names the principal the run recorded for the `from` handle, and every message wait ignores a message whose `from.id` differs from its subject's sender. The payload's display name is no longer compared. A `from` handle the run did not spawn or bind refuses the wait. Core exports `isFromSubjectSender`, the receive check every endpoint path already applies.
