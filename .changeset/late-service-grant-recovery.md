---
"@cotal-ai/core": patch
---

Connected callers can use newly granted endpoint commands without a manual reconnect.
`CotalEndpoint.invokeService` rebuilds its connection and retries once after a broker permission
refusal marked `not-executed`, within the original deadline. Responder refusals and calls that
may have run are not replayed.
