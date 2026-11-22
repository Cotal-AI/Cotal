---
"@cotal-ai/cli": patch
---

Move the status command's flag grammar, result types and gap collector out of `status.ts` into an internal `status-model.ts`. `status.ts` re-exports every name it exported before, so the module surface is unchanged.
