---
"@cotal-ai/workspace": patch
---

Move the maintenance foundation (the journal and lock contract types, MaintenanceError, store identity, the process owner and the maintenance lock) out of `maintenance.ts` into an internal `maintenance-foundation.ts`. `maintenance.ts` re-exports every public name, so the package surface and import paths are unchanged.
