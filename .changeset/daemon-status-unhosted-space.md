---
"cotal-ai": patch
---

`cotal daemon status --space <name>` now refuses with `TARGET_NOT_FOUND` (exit 2) and lists any hosted spaces when the background service does not host a Manager for `<name>`, instead of reporting a stopped Manager and exiting 0.
