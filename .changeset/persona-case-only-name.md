---
"@cotal-ai/cli": patch
---

`persona create` and `personas new` now refuse with `CONFLICT` a name that differs from an existing
persona's only in case, such as `Rev` beside `rev`, and write nothing. A case-insensitive file
system holds the two as one file.
