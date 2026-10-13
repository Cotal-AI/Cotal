---
"@cotal-ai/cli": patch
---

Stop the spawned nats-server when `cotal up` cannot write `.cotal/nats.pid`, in both the foreground and the detached launch. `up` now exits with the write error and no broker left running, and leaves whatever is at the pid path in place.
