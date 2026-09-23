---
"@cotal-ai/delivery": patch
"@cotal-ai/core": patch
---

The delivery daemon now watches its own shard lease key with a KV watch and quiesces at the delivery latency of that row's update instead of waiting for its next renew tick, so a takeover no longer leaves two processes serving one shard for up to a full renew period. The delivery credential gains the read-axis consumer rows on the lease bucket that the watch's ordered consumer needs.
