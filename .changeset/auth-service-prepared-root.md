---
"@cotal-ai/cli": patch
---

Refuse adding the auth-service preset until its hosting root has prepared user-auth state.
The refusal names `cotal up --user-auth --idp <url>` and saves no definition or instance.
