---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Report a refused presence-KV write by naming the bucket and how long writes have been refused, instead of asserting the mesh is unreachable while the transport is connected. A latched presence bucket still opens and watches cleanly, so only the write reveals it; bind now fails with that detail rather than a bare timeout, and `cotal_connection_status` carries a distinct `presenceWriteFailure` field. The record is connection-scoped: it is cleared whenever a connection is torn down, rebuilt or stopped, so a later failure on a different connection cannot inherit it and be described as a bucket refusal.
