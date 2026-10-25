---
"@cotal-ai/cli": patch
---

`cotal service logs` on a service log this account cannot read ended `OPERATION_UNKNOWN` (exit 3) with the raw `EACCES` error and no remedy, though it only reads. It now refuses `PERMISSION_DENIED` (exit 2), naming the log and `chmod u+rw`, with the path quoted when a shell would split it.
