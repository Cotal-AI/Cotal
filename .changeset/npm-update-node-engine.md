---
"@cotal-ai/cli": patch
---

Self-update works from projects where npm needs a newer Node than Cotal does. When the Node recorded by a global npm installation supports the selected npm, the updater uses it for npm subprocesses without changing the project's Node.
