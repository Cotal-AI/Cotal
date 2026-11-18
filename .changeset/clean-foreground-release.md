---
"@cotal-ai/cli": patch
---

Stopping a foreground stack from another terminal no longer prints a crash warning after a clean broker exit. The foreground notice leaves registration cleanup to `cotal down`.
