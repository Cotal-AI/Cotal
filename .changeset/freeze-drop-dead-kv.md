---
"@cotal-ai/core": minor
---

`freezeExpectedSet` and `epScatterService` no longer take a KV handle.

The freeze enumerates via `STREAM.INFO` + `subjects_filter` and reads slots via leader-served
`STREAM.MSG.GET` — both through the JetStream manager. The KV argument was unused after the
enumeration conversion; callers that only opened a records bucket to pass it in can drop that open.
