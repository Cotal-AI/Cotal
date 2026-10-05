---
"@cotal-ai/connector-opencode": patch
---

An OpenCode 1.x seat whose instance the host disposes now ends instead of staying up off the mesh. OpenCode disposes an instance while its server keeps running, for example after a global config change or on `POST /instance/dispose`, and the next request loaded the plugin again from its process-wide cache. That handed back the stopped seat: the server kept running with the agent off the mesh, every `cotal_*` tool and native prompt was refused, and the manager still listed the seat as running. `dispose` now runs the same teardown as a stop and then exits the server, and the launcher closes the attached TUI when its server exits, so the manager sees the seat end.
