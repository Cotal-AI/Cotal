---
"@cotal-ai/auth": patch
---

The doc comment on `reconstructRemoteManagerServeGrant`, which ships in `dist/manager-contract.d.ts`, now says what the function does: it is the activation entry and derives the serve grant from the submitted `ai.cotal.manager` document through `remoteManagerServeGrantFromCluster`. It described a canonical manager surface mirrored from the manager package that activation was checked against, and the module holds no such value. No runtime change.
