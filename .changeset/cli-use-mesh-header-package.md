---
"@cotal-ai/cli": patch
---

The `useMesh()` header comment, which ships in the CLI's `dist/console/mesh.js`, no longer says the `MeshView` model lives in `@cotal-ai/core`. It now points at `../view/mesh-view.ts` in the CLI package, where the class is defined. No runtime change.
