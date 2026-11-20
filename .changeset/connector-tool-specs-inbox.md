---
"@cotal-ai/connector-core": patch
---

Move the `cotal_inbox` tool spec and the inbox read it runs out of `tool-specs.ts` into `tool-specs-inbox.ts`. The tool types and the shared result helpers move into `tool-specs-shared.ts`. `tool-specs.ts` re-exports the types, and the package index exports the inbox names it exported before. The package surface is unchanged.
