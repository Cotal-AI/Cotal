---
"@cotal-ai/manager": patch
"@cotal-ai/core": patch
"cotal-ai": patch
---

The manager no longer ends its own process over its liveness lease. A renew that fails is re-read; a key still its own is adopted, a gone key is re-acquired, a key held by another process is reported and served through, and a broker that cannot be asked is retried for as long as it takes. Each change of state is one line in `manager.log`. The fail-close that took a manager and every pty seat it held down one tick past the lease TTL is removed, together with the detach-on-lease-loss path it needed. The endpoint also drops its manager-lease KV handle when it rebuilds a closed connection; before, every renew after a reconnect ran on the dead handle and timed out for good.
