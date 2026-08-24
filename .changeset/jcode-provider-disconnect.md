---
"@cotal-ai/connector-jcode": patch
---

Keep a managed Jcode seat alive when a provider failure closes its private Harness API connection
mid-turn. The connector now leaves the failed turn unacknowledged, makes one private replacement,
reattaches the same owned session, and then resumes mesh delivery. A failed replacement or a second
connection loss fails loud instead of retrying bridge launches without bound.
