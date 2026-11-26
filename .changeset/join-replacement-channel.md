---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

When `cotal join` rejects a credential from another space, its replacement command includes a read grant for the requested channel without adding publish access.
