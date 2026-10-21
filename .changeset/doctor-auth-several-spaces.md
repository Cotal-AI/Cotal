---
"@cotal-ai/cli": patch
---

`cotal doctor auth` without `--space` on a root that holds several spaces refuses with `TARGET_AMBIGUOUS` (exit 2), names the spaces and asks for `--space`. It no longer reports that root's valid inventory as `SCHEMA_INVALID`.
