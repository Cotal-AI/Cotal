---
"@cotal-ai/cli": patch
---

Unpinned CLI calls to a manager no longer fail when the class queue sends the describe and the invoke to different managers. A manager that receives a call bound to another instance refuses it before running it, and the CLI's manager commands (`models`, `stop`, `spawn --detach` and the rest), `cotal invoke` and the manager row of `cotal status` now re-describe and re-issue after that refusal, up to 16 times, instead of printing it. Before this, a space with three managers failed about two calls in three. The refusal still surfaces once every attempt has split, and a call pinned with `--on` is never re-issued.
