---
"@cotal-ai/cli": patch
"@cotal-ai/delivery": patch
---

A space that is missing its connection-evictor credential can mint that one file with `cotal mint-evictor`, from the system-account seed the root already retained, without rotating the system account or restarting the broker. A root that retained no seed, a missing membership observer, and a broker that hosts more than one space still use the system-account rotation.
