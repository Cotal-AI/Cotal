---
"@cotal-ai/cli": patch
---

Repair now removes read-only seed generations left by an older failed connector install. Garbage collection makes unreferenced generations' directories owner-writable before deleting them.
