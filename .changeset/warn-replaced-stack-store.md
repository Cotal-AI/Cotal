---
"@cotal-ai/cli": patch
---

Warn when a local stack's broker store has been replaced, before a restart can silently lose retained history.

Record the store directory identity at broker startup and compare it in status, shutdown previews, shutdown and startup. Status also reports an unreadable stack journal with its permission repair.
