---
"@cotal-ai/cli": patch
---

`cotal personas new` demanded `--subscribe` while the command registration
refused the flag as unknown — a catch-22 that made persona creation impossible
through the shipped binary. The registration now declares it (and the usage
names it).
