---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Starting a manager with a malformed roster leaves its saved definition unchanged, and the dry run shows why the start would fail.
