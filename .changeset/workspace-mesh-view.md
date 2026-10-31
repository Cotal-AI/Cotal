---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Move `MeshView`, the live model of a space, from `@cotal-ai/cli` into `@cotal-ai/workspace`, exported as `@cotal-ai/workspace/view`. The same entry adds `openObserver`, which builds the read-only observer endpoint that `cotal console` and `cotal watch` each used to construct inline. Console and watch behave as before. `@cotal-ai/cli` never exported `MeshView` from its package entry, so no public export is removed.
