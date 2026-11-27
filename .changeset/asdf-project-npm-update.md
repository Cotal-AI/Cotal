---
"@cotal-ai/cli": patch
---

Self-update resolves an asdf `npm` shim from the current project before running npm outside the project, including during connector reconciliation, using the project's selection even when asdf also sets a home default.
