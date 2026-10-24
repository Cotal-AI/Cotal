---
"@cotal-ai/cli": patch
---

`backup recover` now ends its receipt with the next steps. After a stale restore is rolled back it
names `cotal up` and `cotal backup restore <directory>`. After an interrupted backup is released it
names `cotal backup create <directory>` and `cotal up`.
