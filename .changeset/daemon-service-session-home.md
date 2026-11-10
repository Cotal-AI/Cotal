---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

Use the selected daemon home's sign-in for service registration and activation. Authority and renewal calls carry an explicit provider-session directory, so a separate daemon cannot borrow the default home's account; callers that omit the directory keep their existing behavior.
