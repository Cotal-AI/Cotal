---
"@cotal-ai/cli": patch
---

`service logs --tail <n>` reads back from the end of a log until it has n lines, up to 16 MiB, so
long lines no longer cut a tail short at 1 MiB. `service remove` deletes the removed instances' logs
and names each file it deleted.
