---
"@cotal-ai/cli": patch
---

`cotal meshes rm` with several names reads the registry once and the current-mesh pointer once. It resolves every name against that one read, reports a missing or running name, and removes the accepted records together. The pointer is cleared only when it names one of the removed records, and the notice that there is no default mesh still prints then.
