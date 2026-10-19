---
"@cotal-ai/runtime": patch
---

The run drivers now wait for a checkpoint settle with the same poll loop the runtime suites exercise. `createRunEffectHost` built its own inline copy of the `EpfSettleWatcher` loop with a hardcoded 2 second cadence, so a change to the watcher's loop or to the shared poll cadence left the shipped copy behind. The loop now lives in one class, which polls the read it is given at the cadence the handler already uses for fires. `createRunEffectHost` builds it over its run-scoped settle read, and `EpfSettleWatcher` keeps its constructor and builds it over the direct EPF read. The cadence and the per-poll authority check are unchanged.
