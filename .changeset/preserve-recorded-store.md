---
"@cotal-ai/cli": patch
---

`down --preserve-state` now cuts the store the mesh record names, such as a
`backup restore --store-dir` target. It used `.cotal/nats` unless `--store-dir` was passed, so after
a restore into another store it stopped the delivery daemon, left a mismatched prepare intent and the
manager fenced, and exited with an unknown outcome. A `--store-dir` that differs from the recorded
store now refuses `CONFLICT` before anything stops.
