---
"@cotal-ai/cli": patch
---

Keep `--discard-history` out of backup cleanup retries unless the original command included it, and warn when the old store holds the only copy of data the restore left out.
