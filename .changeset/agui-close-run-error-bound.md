---
"@cotal-ai/connector-core": minor
---

The AG-UI emitter builds an error close's `RUN_ERROR` directly from the fixed `run failed` message, and `packUnits` bounds the closing frame as it does every other. The helper that could shorten an upstream failure detail behind a notice is gone: the close has passed only the fixed message since upstream detail stopped reaching the wire, so its truncation search never ran, and its notice-only fallback was larger than the event it replaced. A close whose envelope cannot fit still fails loud, now with `packUnits`' refusal. `takeCodePoints` is no longer exported, since the preview splitter is its only user. Code that imported it takes a string's first `n` code points with `Array.from(s).slice(0, n).join("")`.
