---
"@cotal-ai/manager": patch
---

When the checkpoint lookup behind `run-answer` fails on a signerless manager, the caller now gets the
host's own rejection. A `run-operator` issuance that rejected with `null` or `undefined` surfaced as
the manager's own `TypeError: Cannot read properties of null (reading 'name')`. A missing open
checkpoint, and an unamendable one for an amendment, are still refused as `not-found`.
