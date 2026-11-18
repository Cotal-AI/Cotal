---
"@cotal-ai/connector-claude-code": patch
"cotal-ai": patch
---

Updates leave Claude configuration untouched when no Cotal integration is installed.
The refresh checks installation records before taking mutation locks, so a read-only unused Claude directory no longer blocks reconciliation or its rollback.
