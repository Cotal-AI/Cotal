---
"@cotal-ai/workspace": patch
---

Move the restore lifecycle (restore contexts and claims, the restore listener and its custody, and the settling, activation, rollback and retirement of a restored root) out of `maintenance.ts` into an internal `maintenance-restore.ts`. `maintenance.ts` re-exports every public name, so the package surface and import paths are unchanged.
