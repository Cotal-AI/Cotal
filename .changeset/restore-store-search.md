---
"@cotal-ai/cli": patch
---

Restore commands refuse an unsearchable store path before starting a restore. They report `PERMISSION_DENIED`, name the directory blocking access and explain how to retry without changing the preserved state.
