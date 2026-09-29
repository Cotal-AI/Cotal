---
"@cotal-ai/delivery": patch
"@cotal-ai/core": patch
---

Expose an account-scoped delivery service handle with explicit store identity and per-context close while retaining the CLI daemon runner. Close membership connections after disconnected drains so stopped contexts cannot reconnect when the broker returns.
