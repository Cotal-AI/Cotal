---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Self-update uses the compatible Node.js that asdf selects for the current project, including when a symlink points to a version-named executable, and keeps using it for npm during connector reconciliation.
