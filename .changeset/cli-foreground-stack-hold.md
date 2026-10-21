---
"@cotal-ai/cli": patch
---

Keep a foreground controller stack alive while it waits for an interrupt, even after startup sockets close. The partial agent-readiness receipt no longer precedes an unintended process exit. Interrupts still use the same guarded whole-stack stop and do not add agent retirement or force killing.
