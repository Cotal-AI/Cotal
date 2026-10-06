---
"@cotal-ai/cli": patch
---

Foreground `cotal up` and `cotal up --detach` now run the steps after their listener is ready through one function: the space setup, the user-auth service, the mesh record, the transport policy and the control plane. When the space setup of a fresh foreground boot failed, for example on a channel seed with an invalid `replayWindow`, `up` exited 1 but left its nats-server running on the port with `.cotal/nats.pid` in place and no mesh record for `cotal down` to find. It now stops the listener and removes the pid file, as `--detach` already did. A foreground TLS boot also writes its broker policy after the mesh is recorded, in the same order as `--detach`.
