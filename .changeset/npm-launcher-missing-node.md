---
"cotal-ai": patch
---

When `cotal update --self` refreshes the npm launcher and the recorded Node is no longer on disk, record the supported Node that ran the update so the launcher still starts when Node is not on PATH.
