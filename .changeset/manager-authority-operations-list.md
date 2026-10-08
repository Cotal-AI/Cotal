---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

`@cotal-ai/core` exports `REMOTE_MANAGER_AUTHORITY_OPERATIONS`, the frozen list of manager-service authority operations, and `RemoteManagerAuthorityRequest["operation"]` is derived from it. The auth request parser checks the operation against the same list and builds its refusal from it, so an operation added to core is admitted by the host instead of compiling cleanly and being refused at runtime with the old list. The refusal now reads `operation must be one of prepare, activate, renew, session, retire, renewStandingBundle, renewRunDriver, transferReader`.
