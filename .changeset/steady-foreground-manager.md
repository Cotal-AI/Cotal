---
"@cotal-ai/cli": patch
---

Keep a foreground native service attached to its owned child while startup readiness remains pending, so a manager still registering does not lose its controller at the background observation deadline. Individual readiness calls remain bounded, and background and HTTP deadlines are unchanged.
