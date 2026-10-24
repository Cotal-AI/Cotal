---
"@cotal-ai/cli": patch
---

`cotal up --host 0.0.0.0` opened the broker, a plaintext broker websocket and the manager's plain HTTP console on every interface, while its receipt and `service status` named only the broker's loopback URL. The controller stack's receipt now has a `Listeners` section naming each listener with its address, how far it reaches and whether it is encrypted, and says when a plaintext listener is reachable from other machines. `service status stack-broker` and `service status stack-manager` list their own while they run, and `--json` carries the list as `listeners`. The manager picks its console's port when it starts and records it nowhere, so the console is named by its host.
