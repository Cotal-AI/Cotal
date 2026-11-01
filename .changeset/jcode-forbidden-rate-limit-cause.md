---
"@cotal-ai/connector-jcode": patch
---

Name a provider's HTTP 403 and HTTP 429 refusals of the Jcode readiness turn as `provider_forbidden` and `provider_rate_limited` instead of an unknown startup failure, without exposing provider output.
