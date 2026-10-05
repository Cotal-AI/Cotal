---
"@cotal-ai/manager": patch
"@cotal-ai/seat": patch
---

A static retirement interrupted after its lifecycle audit was written now completes when a later manager process retries it. The retry compared the stored audit against its own manager process uid and broker eviction counts, so every process after the first, and any retry that found the connections already kicked, failed with `records different evidence` and left the slot `terminalizing`. The comparison now keys on the stable retirement identity: the principal, alias, lifecycle uid, manager instance and retirement op. The pty reaper also treats a custody record from an earlier boot as a seat that is gone. It used to refuse such a record, which held the name after a reboot on every attempt; it now removes the record without signalling anything, since no process outlives a reboot, and `cotal seats` reports it as `childless`.
