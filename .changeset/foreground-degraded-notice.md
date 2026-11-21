---
"@cotal-ai/cli": patch
---

The foreground startup smoke test waits for the full degraded control-plane notice so a slow stderr reader does not cause a false failure.
