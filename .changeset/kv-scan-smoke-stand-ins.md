---
"@cotal-ai/core": patch
---

The kv-scan smoke's iterator stand-ins now carry only the members `liveKvEntries` calls: `close` in every cell, plus `stop` in the mid-scan abort cell, the one that passes a signal. The rotation cell no longer forwards `status` and `stop`, the incomplete-scan cell no longer defines `stop`, and the mid-scan cell drops its optional calls and `Promise.resolve()` fallback and now passes the abort reason through to the client's `stop`. Each stand-in types the real iterator from the client's `consume()` return instead of a hand-written shape. Shipped behaviour is unchanged.
