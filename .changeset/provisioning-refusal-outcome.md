---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

`cotal spawn --foreground` on a remote user-auth mesh now reports a provisioning refusal as a refusal. With no sign-in, or when the agent-provisioning endpoint answers 401, it exits 2 with `AUTH_REQUIRED`. When the endpoint answers 403 it exits 2 with `PERMISSION_DENIED`. Before, both were reported as an unknown outcome (`OPERATION_UNKNOWN`, exit 3), which told a script the agent might have been provisioned. Any other provisioning failure is still unknown.
