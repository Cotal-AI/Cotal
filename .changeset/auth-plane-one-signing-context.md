---
"@cotal-ai/auth": patch
---

The auth service's authority plane no longer rebuilds the data account's signing context inside remote manager maintenance, run admission and run attempt issuance. The serve-executor and run-admitter mints, the run admission's issuer window, and the run-driver, run-mediator and run-operator mints now use the plane's `issuerAuth()`, so a change to how the plane signs reaches them with the plane's other issuer windows and mints. No behavior changes.
