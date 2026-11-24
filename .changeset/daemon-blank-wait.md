---
"cotal-ai": patch
---

Reject a blank `daemon setup --wait` value before service setup instead of treating it as zero. The range error explains how to continue with or without a Manager. An explicit `--wait 0` still skips the wait.
