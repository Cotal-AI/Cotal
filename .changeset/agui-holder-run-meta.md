---
"@cotal-ai/connector-core": patch
---

`AguiEmitterHolder` now takes an optional `runMeta` provider as its fifth constructor argument, so a run closed out of band through `closeRun` can carry `cotal.stopReason` and `cotal.usage` on its `RUN_FINISHED` or `RUN_ERROR`. Before, the holder close forwarded only the timestamp and an error, so the emitter's `cotal` parameter was unreachable from every connector hook. The provider is asked inside the queued close, after the flush queued ahead of it has mapped the turn's last records, and is keyed on the run being closed, so a provider that only knows another run puts nothing on this one. `AguiEmitter` gains an `openRunId` getter naming the run `closeRun` would close.
