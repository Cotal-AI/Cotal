---
"@cotal-ai/workspace": patch
---

Move the maintenance journal (the persisted record validators, listener custody proofs, the resume document and the journal read/validate/write path) out of `maintenance.ts` into an internal `maintenance-journal.ts`. `maintenance.ts` re-exports every public name, so the package surface and import paths are unchanged.
