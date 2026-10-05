---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
---

Apply the driver's result bound on the compiled engine. A hosted run on language version 2 never received the result bound that `cotal run` and the manager derive from the broker's `max_payload`, so an oversized effect result was recorded when it fit the store, or released as the store's own L5010 when it did not. The bound now reaches the journal the worker thread builds, an oversized `ok` result is refused ahead of the settling append (L5006) as it is on version 1, and the host rebuilds that refusal as `EffectResultTooLarge`, so the driver releases the run instead of recording it as failed. `WorkerRunRequest` gains `resultBytes`, refused outside the bridged route, and `WorkerRunFailed` gains `tooLarge`.
