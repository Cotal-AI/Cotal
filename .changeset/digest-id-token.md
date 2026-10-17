---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
---

`@cotal-ai/core` now exports `digestIdToken`, the one recipe behind every id derived from a digest (the 43-character base64url sha256). Run notice and migration ids, checkpoint answer ids, the runtime's derived pause tokens and the manager's turn hold token all use it. Before this, each module kept its own copy, so a change to one copy could pass the typecheck and quietly stop matching the ids the others derive. The derived ids are unchanged.
