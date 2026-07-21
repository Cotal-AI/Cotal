---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Add `cotal -v` / `cotal --version`: print the binary version plus each installed extension's, then exit. `cotal status` gains the same report — the Machine section leads with the `cotal-ai` version, and a new Extensions section lists each installed extension with its pinned version, so version skew across the seeded connectors is visible at a glance.
