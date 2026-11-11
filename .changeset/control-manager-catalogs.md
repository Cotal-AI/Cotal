---
"@cotal-ai/workspace": patch
---

A terminal surface can ask a space's manager which applications and models it can run, so a spawn form offers what that manager has instead of what this machine has installed.

`control()` from `@cotal-ai/workspace/control` now accepts the `managerStatus` and `models` operations, with the same caller profile as `start`.
