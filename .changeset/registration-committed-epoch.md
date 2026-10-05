---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A manager start now serves at the process epoch its own registration committed. Both the boot registration and `registerRemoteManagerAuthority` read the issuance gate again after `registerServiceInstance` returned and took that read's epoch, so a start that a second start of the same instance superseded in between authorized its serve grant at the successor's epoch, and the remote path returned the successor's epoch and registration revision as its own. `registerServiceInstance` now returns the `processEpoch` its completing reopen committed, both registration paths use it, and the serve grant's epoch check refuses a superseded start with `expired`.
