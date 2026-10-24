---
"@cotal-ai/cli": patch
---

`cotal status` listed the selected space's service instances, in its rows and in `result.services.instances` under `--json`, by their random instance IDs, so the stack's members changed order whenever one started under a new ID. They are now listed by definition name, then instance ID, as `result.services.definitions` is.
