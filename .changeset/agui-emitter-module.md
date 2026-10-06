---
"@cotal-ai/connector-core": patch
---

The AG-UI emitter now lives in its own module. `agui.ts` keeps the event vocabulary, the frame envelope, the bracket machine, the preview splitter and the egress policy, and no longer imports the durable source, the WAL, the subject frontier or the channel derivation, which also removes its import cycle with the WAL. `AguiEmitter`, `packUnits` and the emitter's types and errors moved to `agui-emitter.ts`, and the package index re-exports both modules, so every name keeps its import path. `takeCodePoints` is newly exported because the emitter's error-close bound shares it with the preview splitter. No behavior changes.
