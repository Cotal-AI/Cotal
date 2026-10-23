---
"@cotal-ai/cli": patch
---

`backup create` without `--store-dir` now backs up the preserved cut's recorded source store. It used
`.cotal/nats`, so after a restore into another store it refused `path-missing` although the cut was
ready.
