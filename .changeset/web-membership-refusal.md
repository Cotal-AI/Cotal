---
"@cotal-ai/web": patch
"cotal-ai": patch
---

fix(web): tell the browser a membership read failed instead of serving it as empty

The dashboard's `/api/membership` route answered a failed read with `{asOf: undefined, members: []}`
and a 200. `JSON.stringify` drops a key whose value is `undefined`, so those bytes are
`{"members":[]}` — byte-identical to a successful read of a space where nobody is subscribed. The
graph then reported the feed as `membership: traffic-only`, which asserts that the mesh publishes no
membership feed, when the truth was that the read did not answer.

A failed read now carries a 503 and names its condition; the two server-sent-event paths emit a
named event instead of swallowing the rejection; and the page stops manufacturing an empty snapshot
from a failed fetch or a non-200. The freshness pill gains an `unreadable` state, tested before
`traffic-only` so a refusal cannot borrow that phrase.
