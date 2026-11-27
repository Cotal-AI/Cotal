---
"@cotal-ai/cli": patch
---

Self-update resolves an asdf `npm` shim from the current project before running npm outside the project, including during connector reconciliation, using the project's selection even when asdf also sets a home default.
Connector seed children started inside an update or with an inherited update runtime hint also keep the verified Node selected to run npm.
