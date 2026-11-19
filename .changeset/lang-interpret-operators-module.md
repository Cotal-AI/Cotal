---
"@cotal-ai/lang": patch
---

Move the walker's operator helpers (`applyBinary`, the no-coercion and update-operand refusals, and canonical array indexes) out of `interpret.ts` into an internal `interpret-operators.ts`. The package surface is unchanged.
