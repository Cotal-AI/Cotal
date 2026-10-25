---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

Process services, and with them a prepared stack's `cotal up` and `cotal down`, run on macOS. The
direct-process driver pins the machine's hardware UUID, the boot session UUID, the OS user and each
process's start in microseconds, read through the bundled binding, where Linux pins its machine ID,
boot ID and start ticks. A background start leads its own process group, and a stop signals and
waits for that whole group, as on Linux. The manager's native child, its stop reservation and the
native service identity records accept the same pins. Before, each of these refused with
`UNSUPPORTED` on macOS.
