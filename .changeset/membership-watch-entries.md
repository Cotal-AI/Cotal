---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

`watchMembership` delivers each membership-feed entry to its callback as a `MembershipChange` (the decoded member record or its deletion, the heartbeat's `asOf`, and one `replayed` marker closing every replay) instead of a bare tick. The web dashboard, `cotal view` and `cotal channel members --follow` copy a heartbeat into their last snapshot's `asOf` and read the feed back only on a member change; before, every heartbeat the delivery daemon wrote cost each observer a full ordered-consumer rescan of the bucket with nothing changed.
