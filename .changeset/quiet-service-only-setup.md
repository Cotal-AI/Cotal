---
"cotal-ai": patch
---

Refuse daemon setup with --no-manager on account-managed computers before changing any space.
The refusal directs operators to the account dashboard without registering a machine service or starting an agent host. Per-space hosts retain service-only registration and approval waiting, without agent-host startup progress.
