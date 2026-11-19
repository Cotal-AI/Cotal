---
"@cotal-ai/cli": patch
---

`pnpm dlx` runs under pnpm 11, which start the package from its global virtual store, are now recognised. The entry card and `status` suggest `pnpm dlx cotal-ai` commands instead of Node plus a store path, and `setup` offers the global install it offers under other `pnpm dlx` runs.
