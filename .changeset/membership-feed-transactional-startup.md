---
"@cotal-ai/core": patch
---

`startMembershipFeed` no longer leaves its observer connection open when startup fails. Conn A is
opened first, and every step after it can throw: an rw credential source that rejects, credential
bytes the identity parser refuses, conn B's own dial, either KV open, the first reconcile. The only
`drain()` in that file lives inside the handle's `stop()`, and a caller whose startup rejected never
receives the handle — so the observer connection stayed open for the life of the process, with
nothing left holding a reference to it. Startup is transactional now: every connection acquired so
far is drained before the rejection propagates, and the rejection itself is unchanged, so a caller
that already handles the failure sees exactly what it saw before.
