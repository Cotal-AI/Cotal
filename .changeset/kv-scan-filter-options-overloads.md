---
"@cotal-ai/core": minor
---

`liveKvEntries` and `liveKvValues` now declare separate `(kv, options?)` and `(kv, filter, options?)` overloads (and the matching `decode` pair on `liveKvValues`), and refuse a call that passes options in the filter slot followed by a second options argument instead of dropping the trailing options. This is a breaking call-shape restriction: combine the signal and callbacks into one options object.
