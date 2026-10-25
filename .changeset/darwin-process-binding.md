---
"@cotal-ai/workspace": patch
---

`@cotal-ai/workspace` has a macOS process identity binding beside the Windows one. It reads a process's
start time in microseconds, its process group and whether it is stopped with `sysctl`, a process
group's members with `KERN_PROC_PGRP`, and the machine and boot UUIDs with `gethostuuid` and
`kern.bootsessionuuid`. A build on macOS compiles it against the checksum-pinned Node headers for
macOS 11.0 and later and records a verified build receipt, as the Windows binding does.
