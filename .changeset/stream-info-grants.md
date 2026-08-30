---
"@cotal-ai/core": patch
---

`provisionAgent`'s agent-profile grant template emitted the JetStream consumer-create deny triple
on the DM, TASK, and DLV streams while granting `$JS.API.STREAM.INFO` on none of them. Every
JetStream API call is a NATS publish, so a role-carrying actor was refused stream-level state reads
(message counts, first/last seq) on the task stream it binds its `svc_<role>` consumer to.
`STREAM.INFO` on TASK now sits inside the same `if (role)` gate as the rest of that stream's
grants, so it tracks the role like every other TASK row and a role-less agent still holds nothing
on TASK. DM, DLV, and the EPC contract store get no such grant: `subjects_filter` is a
request-body field no ACL can narrow to counts alone, so INFO there would enumerate DM and delivery
subject metadata across peers, and no agent-side caller reads those streams at stream level. The
consumer-create deny triple is untouched.
