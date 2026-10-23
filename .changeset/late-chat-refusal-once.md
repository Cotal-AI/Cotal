---
"@cotal-ai/core": patch
---

A channel subscription that the broker refuses after the join was confirmed, for example after a
permission reload, now reaches the endpoint's `error` event once, as `left channel "<channel>"`, with
the broker's permission violation as its `cause`. It was also reported a second time as a generic
`NATS permission denied` error, so an embedder could not count or alert on it once.
