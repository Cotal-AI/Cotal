---
"@cotal-ai/connector-core": patch
---

A channel set quiet, muted or left during a turn no longer has that turn's posts delivered again when the turn fails. The change now applies to them once the failed turn releases them, so they stay readable with `cotal_inbox` instead.
