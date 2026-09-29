---
"@cotal-ai/workspace": patch
---

Add `retireManagerInstanceIdentity(root, space, expected)`, which deletes a space's persisted manager instance identity only when the stored record is the complete expected identity. A symlinked, malformed or different record is refused and kept, and a missing record returns `absent` so an interrupted retirement can be retried.
