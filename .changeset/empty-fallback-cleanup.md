---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Backup fallback cleanup no longer requires `--discard-history` solely because a verified empty store was preserved after the backup was made.
