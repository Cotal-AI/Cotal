---
"@cotal-ai/cli": patch
---

Backup creation retries now quote paths with spaces for a POSIX shell. If a path cannot be displayed unchanged, the CLI asks you to rerun your original command instead.
