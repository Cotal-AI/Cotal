---
"@cotal-ai/manager": patch
---

Use native signing for the Manager's standing broker connections.
The service, goal-writer and session-ledger connections use the existing connection helper with current-credential getters while retaining their identity-bound inboxes and transport policy.
