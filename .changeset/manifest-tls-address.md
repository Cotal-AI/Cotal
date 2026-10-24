---
"@cotal-ai/cli": patch
---

`cotal up -f` with `--tls-cert` now refuses a manifest whose `broker.servers` names a `nats://` address, before anything starts, and names the `tls://` form to use, as a bare `up` already refused `--server nats://`. It used to start the broker, fail the readiness check, and stop it again.
