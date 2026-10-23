---
"@cotal-ai/cli": patch
---

`cotal ext remove` creates a missing process-record folder under a mesh root's `.cotal` with mode
0700. Under a group-writable umask, the reservation it takes for a provider whose records sit in a
folder of their own left that folder 0775.
