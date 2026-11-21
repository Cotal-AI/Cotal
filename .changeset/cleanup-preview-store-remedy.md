---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

When cleanup refuses because the mesh is still running, the retry command keeps the selected store and remains a preview if you used `--dry-run`.
