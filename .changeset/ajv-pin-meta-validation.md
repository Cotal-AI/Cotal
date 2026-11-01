---
"@cotal-ai/core": patch
---

Pin ajv's `validateSchema` and `meta` in the contract schema profile, so a malformed keyword value such as `{"type": 5}` keeps refusing as `contract-invalid` even if ajv's defaults change.
