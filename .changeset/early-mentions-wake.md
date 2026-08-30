---
"@cotal-ai/connector-claude-code": patch
---

Reconcile a wake when the Claude channel activates. A focus mention received during channel startup is re-notified before buffered inbox work, while repeated active state remains a no-op.
