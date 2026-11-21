---
"@cotal-ai/runtime": patch
---

When `run revoke` rejects `--json` or `--plain`, it tells you to remove that flag from the original command so the supplied actor, reason, and target stay intact.
