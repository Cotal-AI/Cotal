---
"@cotal-ai/core": patch
---

`provisionAgent`'s agent-profile grant template emitted the JetStream consumer-create deny
triple on the DM, TASK, and DLV streams without a matching `$JS.API.STREAM.INFO` grant, and
never granted it on the EPC contract store either. Every JetStream API call is a NATS publish,
so a provisioned actor was refused stream-level state reads (message counts, first/last seq) on
all four streams, not just consumer creation. Added the four missing `STREAM.INFO` grants; the
consumer-create deny triple is untouched.
