---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Setup rejects an unknown `--harness` before installing built-in extensions or completing a pending extension installation. A built-in or installed connector name still goes through the normal setup checks.
