---
"@cotal-ai/lang": patch
---

A journal append the store refuses now crosses the worker effect bridge as the real `JournalAppendRejected` (or `EffectResultTooLarge`) in both directions. Before, the bridge flattened it into a plain `Error`, so when a host handler's `ctx.bind` was refused and the handler rethrew, the compiled engine settled the step `failed` as an L5010 handler fault and a program `try`/`catch` could catch it. The bridged route now matches the in-process interpreter: the entry stays pending, nothing is settled on top of it, and the run stops on the uncatchable L5010 path.
