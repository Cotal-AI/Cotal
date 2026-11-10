---
"cotal-ai": patch
"@cotal-ai/auth": patch
---

The machine daemon now reports a malformed IdP timeout setting before it starts.
It uses the same timeout validation as direct sign-in, so an invalid
`COTAL_IDP_TIMEOUT_MS` no longer appears as a provider refusal during daemon sign-in.
