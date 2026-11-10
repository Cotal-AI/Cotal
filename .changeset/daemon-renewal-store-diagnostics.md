---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Expose an optional non-secret store-failure classification in service renewal state. Report damaged daemon ready and renewal records as local-state conflicts rather than remote outages, preserving records and request IDs for deliberate recovery.
