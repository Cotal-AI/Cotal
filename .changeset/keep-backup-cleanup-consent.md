---
"@cotal-ai/cli": patch
---

Keep `--discard-history` out of backup cleanup retries unless the original command included it, and offer a preview when cleanup would delete the only copy of data the restore left out.
