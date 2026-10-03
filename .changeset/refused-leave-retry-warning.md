---
"@cotal-ai/core": patch
---

An endpoint now reports its first failed Plane-3 leave after the broker refuses a durable channel's live subscription on `warning` instead of `error`. The endpoint keeps retrying that leave until it succeeds, but the `error` notice killed a host with no `error` listener before the second attempt ran. A host that survived the rejection lost the retry, so the channel stayed `durable-unclosed`. This matches the boot self-join retry, which already reports on `warning`.
