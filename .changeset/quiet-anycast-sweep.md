---
"@cotal-ai/core": patch
---

Avoid creating an idle scan consumer when the anycast records bucket is empty. Maintenance reads the bucket status before enumerating keys and continues processing non-empty buckets as before.
