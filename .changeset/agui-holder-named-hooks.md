---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
---

`AguiEmitterHolder` now takes its hooks as one named object after the emitter factory, `new AguiEmitterHolder(startEmitter, { onError, onRunClosed, waitLive, runMeta })`, typed by the exported `AguiEmitterHolderHooks`, where only `onError` is required. Before, the four hooks were positional, and a `runMeta` provider passed third was accepted as `onRunClosed`: it typechecked, ran after the run had already closed, and its metadata was dropped with no error. A caller no longer fills earlier slots with `undefined` to reach a later hook. The Claude Code, Codex, jcode, OpenCode and pi connectors pass their hooks by name, with no change in behavior.
