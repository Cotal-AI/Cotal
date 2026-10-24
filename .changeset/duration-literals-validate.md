---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
---

`run validate` and `run start` now refuse a literal that is not a duration where a program reads
one, such as `sleep("5")`, `sleep(5000)` or a checkpoint `timeout` of `"PT5M"`, with L2034 and the
same text the call gives. Such a program used to validate and start, then fail its run at the call.
`run start` and `run resume` refuse a `--timeout` that is not a duration longer than zero with
`USAGE_INVALID`, where it used to start a run whose checkpoints then failed.
