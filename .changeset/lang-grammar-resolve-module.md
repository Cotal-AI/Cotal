---
"@cotal-ai/lang": patch
---

Split the validator in `grammar.ts`: the resolution walk (identifier binding and effect call checks) moves to an internal `grammar-resolve.ts`, and the node, scope and pattern helpers both walks use move to an internal `grammar-shared.ts`. The package surface is unchanged.
