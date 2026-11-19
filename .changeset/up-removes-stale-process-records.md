---
"@cotal-ai/cli": patch
---

`cotal up` no longer refuses a controller stack after a reboot because of a stale delivery or manager record. Before it starts a member, `up` removes each process record under the root whose process is gone, or whose pid now runs another start than its identity pin records. It names each one in a `STALE_PROCESS_RECORD` warning, as a complete `cotal down` does, and never signals the process that holds a reused pid. Before, a record whose pid had been reused refused `up` as a legacy process. A record whose pid a process started by the same `up` took refused the delivery member with `LIFECYCLE_BLOCKED`. A record that may front a live process still refuses.
