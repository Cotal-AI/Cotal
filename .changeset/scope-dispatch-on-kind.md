---
"@cotal-ai/lang": patch
---

The scope runner and the compiled engine's scope helpers dispatch on the typed `ScopeKind` instead of the primitive's name. A scope kind added to the union without its runner arm, or without its calling convention in the engine, now fails the build rather than throwing an interpreter defect the first time a program opens it.
