---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

If `cotal down` returns `TARGET_NOT_FOUND` from a folder with no stack of its own, it now tells you to restore the target stack's original folder when a file blocks its recorded path.
