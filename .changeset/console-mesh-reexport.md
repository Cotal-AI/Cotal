---
"@cotal-ai/cli": patch
---

The console's `mesh.ts` no longer re-exports `MeshViewOptions`. Its re-export list is where the console UI imports the model shape from, and no UI module imported that options type; only `useMesh()` uses it, through its own import. The list now names only the types the UI uses. No runtime change.
