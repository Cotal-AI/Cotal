---
"@cotal-ai/core": patch
---

Stopping a principal-route serve no longer waits forever for a handler that never settles.

`PrincipalServe.stop()` and `CotalEndpoint.stop()` abort the new `signal` in every principal handler's context, so a handler can end early, and wait for each handler in flight only until its request's `deadlineMs` has passed since the request arrived. The caller has stopped waiting by then, and a reply that comes later is dropped.

Each serve of the `agent` endpoint now takes a fresh `prompts.seq` from `nextPromptsSeq()` when it starts and shows `{ open: 0, seq }` with it, so one `(runtime.id, seq)` never names two states. A prompt desk's counter therefore starts one higher than before.
