---
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Daemon sign-in now reports an initial device-authorization refusal without suggesting a session was saved.
It exits 2 with guidance to check the provider auth base URL and client ID. Failures that may occur after persistence keep their warning.
