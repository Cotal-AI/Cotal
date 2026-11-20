---
"@cotal-ai/auth": patch
---

Move the authority plane's manager run operations (goal-index scan, admin and participation authorization, run submission, admission, cancellation and revocation, and run-attempt issuance) out of `service.ts` into an internal `service-manager-runs.ts`. The package surface is unchanged.
