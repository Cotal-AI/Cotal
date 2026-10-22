---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A bare `cotal down` of a running legacy stack reads each process record it stops in place, as the stopped-stack check does. A record that check leaves unread, such as one behind a link, a directory or an oversized file, now refuses `LIFECYCLE_BLOCKED` before the first stop and names where reading stopped. Before, the stop read a record through a link into another root and signalled that root's process.
