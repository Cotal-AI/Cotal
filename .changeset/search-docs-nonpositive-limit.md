---
"@cotal-ai/connector-core": patch
---

Return an empty list from `searchDocs` when `limit` is zero or negative instead of collecting one hit before checking the limit.
