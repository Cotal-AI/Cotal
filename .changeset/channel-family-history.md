---
"@cotal-ai/core": patch
---

Read the newest chat messages across a channel family without listing every concrete channel.
`CotalEndpoint.multiChannelHistory(["events.>"], { limit })` uses one broker filter and returns
the same subject-tagged, stream-ordered rows as the equivalent concrete-channel read.
The family must be the only filter, and the broker still enforces the caller's existing grants.
