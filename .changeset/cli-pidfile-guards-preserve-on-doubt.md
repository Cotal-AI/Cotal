---
"@cotal-ai/cli": patch
---

`cotal clean store|all`, `cotal backup create` and `cotal meshes rm` now treat a process record as stopped only when it is absent, empty, or names a pid the kernel reports gone. Before, they read any record not proven alive as stopped, so a garbled record, an extension removal reservation, or a pid whose liveness the kernel would not report let `clean` delete the JetStream store and space identity, `backup` snapshot a store that could still be written, and `meshes rm` drop the record of a running broker, while `cotal down` refused the same records. `cotal status` now shows such a pid as `liveness unknown (<pid>)` instead of `stale pidfile`.
