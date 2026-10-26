---
"@cotal-ai/core": patch
---

Use one owner read per advisory-lock inspection, keeping the stale verdict and inode together through acquisition and serialized reclaim without changing the public inspection result.
