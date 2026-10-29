---
"@cotal-ai/core": patch
---

`liveKvEntries` and `liveKvValues` now declare separate `(kv, options?)` and `(kv, filter, options?)` overloads (and the matching `decode` pair on `liveKvValues`), and refuse a call that passes options in the filter slot followed by a second options argument instead of dropping the trailing options.
