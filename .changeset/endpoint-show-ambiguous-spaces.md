---
"@cotal-ai/cli": patch
---

When several registered spaces match the project folder, `endpoint show <name>` now refuses with `TARGET_AMBIGUOUS` naming each space and the retry for it, instead of a generic message with no names and no retry.
