---
"@cotal-ai/manager": patch
---

`Manager.preparePreservation` now returns an inventory that shares no object with the running seats. Each entry held the seat's own retained `subscribe`, `allowSubscribe`, `allowPublish`, `capabilities` and `shareTools` arrays, its launch `source` and its recorded issuance, so an in-process caller that wrote to the plan changed what the manager kept for that seat: after `abortPreservation` the next cut recorded the widened lists, and a changed `source` digest made it refuse the seat. The control op was not affected, because its reply is serialized.
