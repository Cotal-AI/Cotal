---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
---

Backup fallback cleanup drops `--discard-history` for a newer store only when restore verifies that it holds no additional backed-up state.
