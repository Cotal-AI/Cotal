---
"@cotal-ai/connector-core": patch
---

A peer flooding a channel can no longer silence directed mail. The inbox overflow valve sacrificed
pull-only backlog first, but pull-only requires a non-forgeable signal it did not have: it is
`!mentionsMe && historical`, and `mentionsMe` is read from the payload `mentions` field, which the
sender controls. A peer stamping the victim's name on every flooded message made none of its traffic
pull-only, so eviction fell through to the oldest entry, which is the message that had been waiting
longest, and acked it without marking it handled - unrecoverable, since the broker then never
redelivers. Ordinary ambient channel traffic at volume did the same with no forgery at all.

Eviction now prefers channel traffic over anything addressed to this agent, reading directedness
from the subject-derived `kind` rather than from the payload, and a directed message that must be
sacrificed is left un-acked so it can be redelivered. Channel ambient is still acked, because
replaying it is what the earlier history flood was.
