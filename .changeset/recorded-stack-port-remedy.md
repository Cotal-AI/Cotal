---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

When a non-NATS listener holds a controller stack’s recorded broker address, `cotal status` and `cotal ps` tell you to free that address and restart the stack there.
