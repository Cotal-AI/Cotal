---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Complete a committed registration spec after a lost ack instead of freezing a new coordinate. Boot self-heal and `cotal reconcile-gate` now finish that same freeze when the spec advanced, and abort-reopen only on a definite no-commit.
