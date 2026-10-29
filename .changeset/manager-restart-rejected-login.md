---
"@cotal-ai/cli": patch
---

`cotal manager restart` over a running manager on a user-auth space now confirms the cached sign-in with its IdP before it stops anything, as a restart with no manager running already did. Without a sign-in, or with one the IdP rejects because it expired or was revoked, it refuses `AUTH_REQUIRED` (exit 2) with `cotal login --idp <base>`, then `cotal manager restart` as the next step, and the running manager is left as it was. Before, a hosting folder's restart stopped the running manager and left a replacement that never became ready behind an `OPERATION_UNKNOWN`, and a participant's restart was refused `DEPENDENCY_UNAVAILABLE` with no next step.
