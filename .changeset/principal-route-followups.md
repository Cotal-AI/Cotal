---
"@cotal-ai/core": patch
---

Stopping a principal-route serve no longer waits forever for a handler that never settles.

`PrincipalServe.stop()` and `CotalEndpoint.stop()` abort the new `signal` in every principal handler's context, so a handler can end early, and wait for each handler in flight only until its request's `deadlineMs` has passed since the request arrived. The caller has stopped waiting by then, and a reply that comes later is dropped.

Each serve of the `agent` endpoint now takes a fresh `prompts.seq` from `nextPromptsSeq()` when it starts and shows `{ open: 0, seq }` with it, so one `(runtime.id, seq)` never names two states. A prompt desk's counter therefore starts one higher than before.

A call no longer ends `internal` when something other than the broker's no-responders status reaches its no-responders sentinel. Any client that may make a JetStream API request can name that sentinel as its reply subject, so the caller now drops such a message and keeps waiting for the real reply, on the principal route and on service calls.

A principal-route reply the broker refuses to publish is now reported on the endpoint's `error` event. The status loop used to drop every permission error on a principal-route subject, and this one has no call or serve that reports it.

A principal-route call whose reply read the broker refused now throws `permission-denied` even when the flush it waits on never settles. It used to throw `deadline-exceeded` in that case.

A principal-route request with `replyExpected: false` is now refused before its handler runs. Every command on that route is request/reply, and such a request used to run the handler and send nothing.

A principal serve no longer keeps a subscription handle for every connection it was ever bound on. It retires the handle of a replaced connection once that handle's handlers finish.

`spec/cotal.schema.json` now gives the presence `prompts.open` and `prompts.seq` as non-negative integers, as SPEC §6 says.
