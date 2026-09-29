---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A repair `up` after a broker died reopens the store the mesh record names and refuses a different `--store-dir`. A foreground `up` whose broker exits unexpectedly keeps the mesh record, names the exit and the repair, and exits non-zero.
