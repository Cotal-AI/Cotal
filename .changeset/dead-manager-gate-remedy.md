---
"@cotal-ai/auth": patch
---

When every remote manager an owner registered has exited, the manager-caller refusal now tells the owner to start one with `cotal supervise`. It used to suggest naming an instance with `managerInstanceId`, which cannot revive a dead manager. The call is still refused and is never routed to the local manager.
