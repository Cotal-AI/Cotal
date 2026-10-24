---
"@cotal-ai/manager": patch
---

The launch-uncertain message now names the readiness window in milliseconds, as the manager waited it. It rounded the window to whole seconds, so a connector that declares a window under 500 ms was reported as having no exit and no presence "within 0s", and a 1499 ms window read as "within 1s".
