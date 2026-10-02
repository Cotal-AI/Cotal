---
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
---

The delivery daemon no longer exits when a credential adoption arrives while it is still starting. Its lease turns ready before the membership feed, the timer writer and the lease watch are up, so a manager's boot-time `reloadCreds` could land in that window and reconnect the daemon's connection under the lease watch it was still creating, which then timed out and stopped the daemon. Until start-up finishes, `reloadCreds` is now refused with nothing adopted, and the renewal owner records that refusal. The next renewal pass or the daemon's own 75% re-read adopts the re-signed credentials.
