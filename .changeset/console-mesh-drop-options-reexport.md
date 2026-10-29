---
"@cotal-ai/cli": patch
---

Drop the unused `MeshViewOptions` type re-export from `src/console/mesh.ts` so `mesh.ts` re-exports only the `MeshView` model types that the console UI components import.
