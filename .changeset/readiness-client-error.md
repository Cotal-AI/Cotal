---
"@cotal-ai/connector-jcode": patch
---

Provider HTTP 4xx readiness refusals now report a client-error category instead of an unknown startup failure. Existing authentication, payment, permission, rate-limit and model-refusal diagnostics keep their categories, and provider response text stays private.
