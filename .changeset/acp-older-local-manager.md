---
"@cotal-ai/acp": patch
---

`cotal acp` now recognises a manager service that an older release started on this machine, so a new thread uses it instead of failing to start a second one. A manager from before 0.180 names no machine, so when no listed manager names this machine the bridge reads `cotal manager status` for the space and takes the listed manager with the native instance that this machine's service record runs.
