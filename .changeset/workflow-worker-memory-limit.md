---
"@cotal-ai/lang": minor
---

A workflow run is stopped when its engine thread reaches a 512 MB heap limit.

Each run's worker thread is created with fixed heap limits instead of inheriting the host process's own. A run that reaches the limit is recorded failed with a message naming it, and the host process and its other runs carry on.
