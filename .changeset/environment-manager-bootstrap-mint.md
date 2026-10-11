---
"@cotal-ai/auth": patch
---

Add an internal one-shot environment bootstrap issuer that binds its fixed-profile JWT to the native credential ledger and both lifecycle and registration fences. Repeated or uncertain signing attempts remain held. This does not expose an admission API, deliver bootstrap files or enable hosted execution.
