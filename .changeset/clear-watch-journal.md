---
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

`run show` rejects diagnostic paging flags even with a journal limit, and `watch --json` reports an invalid view with stream error and end records.
