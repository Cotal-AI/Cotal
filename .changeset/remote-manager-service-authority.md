---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"cotal-ai": minor
---

Add closed, host-issued remote manager-service authority for registered user-auth participants. It requires the dedicated `supervise` scope, restricts manager registration and credentials to one owner and opaque instance, and uses a lifecycle-bound prepare, activate, and renew flow with fail-closed renewal and same-owner descendant provisioning.
