---
"@cotal-ai/core": patch
---

Give each remaining single-owner `CotalEndpoint` field to the internal part that reads and writes it: the connection part owns its timers, the observer taps and its watch-consumer and subscription-denial records; the reconnect part owns the retry count and backoff; the consumer part owns the task epoch, first-connect flag and chat subscription refusals; the control plane owns its service caches and split count; the credential part owns its transaction chain and renewal timer; the principal-serve part owns the `prompts` presence field. The package exports, public methods and wire behaviour are unchanged.
