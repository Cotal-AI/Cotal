---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Usage telemetry at `regular` now carries a failure's error text: `errorMessage` with quoted values, URLs, email addresses, IP addresses, paths and token-shaped runs masked, and `errorStack` with at most 12 frames whose paths are cut down to their part inside `node_modules`. docs/telemetry.md lists the masking rules and notes that the intake derives a country from the request address without storing it.
