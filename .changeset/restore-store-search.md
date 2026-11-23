---
"@cotal-ai/cli": patch
---

Restore commands refuse inaccessible or invalid store paths before starting a restore. They explain how to retry without changing the preserved state, and identify the directory blocking search access when possible, even through a symbolic link.
