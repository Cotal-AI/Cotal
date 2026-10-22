---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

`cotal spawn --foreground` on a remote user-auth mesh with no sign-in now exits 2 with `AUTH_REQUIRED`, before any request is sent. Before, it was reported as an unknown outcome (`OPERATION_UNKNOWN`, exit 3), which told a script the agent might have been provisioned. Any failure after the provisioning request, an endpoint 401 or 403 included, is still an unknown outcome.
