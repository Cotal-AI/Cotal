---
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Let bare `cotal down` and Ctrl-C on a foreground `cotal up` stop a stack whose manager runs the built-in in-process `pty` runtime. That manager published no spare capability, so bare `cotal down` refused to signal it even with no agents running, left the broker up, and kept the registry entry; a default `Manager.stop()` threw on any pty seat. A default stop now stops and deprovisions the pty seats that live inside the manager process, since they cannot outlive it, and still releases every seat that can. The manager always publishes its spare capability, which now records whether its stop also stops in-process seats, and `down` reports those seats as stopped instead of left running. An older CLI refuses the new record rather than misreport those seats. A stopping manager refuses new spawns and waits for the ones it already accepted, so no seat launches after a stop that reported success, and `down` no longer promises that agents will be spared when it cannot list them. Repeated `Manager.stop()` calls share one stop, so a second call no longer reports success while the first still waits for a seat to exit.
