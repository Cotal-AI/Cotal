---
"@cotal-ai/core": patch
---

`probeConnect` reports `timeout` only when the dial ran out of its own budget. A peer that answered `CONNECT` with an `-ERR` whose text mentions a timeout, such as `-ERR 'Read Timeout'`, was graded `timeout`, so the off-registry preflight, such as `cotal join --token`, `--creds` or a join link, said the connect "did not complete within 8s" for a peer that refused at once; it is now `unreachable`, like any other refusal. The endpoint grades timeouts and closed connections by nats-core's `TimeoutError` and `ClosedConnectionError` classes instead of by message text, which also applies to the liveness probe and to the membership-watch cleanup.
