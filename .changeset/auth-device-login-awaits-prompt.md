---
"@cotal-ai/auth": patch
---

`deviceLogin` and `establishIdpSession` now await `onPrompt`, which may return a promise. Polling starts only after the prompt settles, and a rejection from it fails the login instead of escaping as an unhandled rejection. The device code's lifetime also bounds the prompt, so one that never settles fails the login at expiry.
