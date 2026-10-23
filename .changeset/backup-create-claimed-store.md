---
"@cotal-ai/cli": patch
---

A `backup create` that recovers an interrupted create's claim first now backs up the cut's recorded
store. On a root whose store is a custom `--store-dir`, it looked for `.cotal/nats` instead, removed
the partial artifact and then failed with an unknown outcome, "store path is missing".
