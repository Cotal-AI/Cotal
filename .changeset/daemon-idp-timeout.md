---
"cotal-ai": patch
"@cotal-ai/auth": patch
---

The machine daemon now reports a malformed IdP timeout setting before it starts.
It uses the same timeout validation as direct sign-in, so an invalid
`COTAL_IDP_TIMEOUT_MS` no longer appears as a provider refusal during daemon sign-in.
The setting accepts whole milliseconds from 1 to 2147483647, preventing fractional
values from failing inside a request and oversized delays from becoming a 1ms timeout.
