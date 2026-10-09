---
"@cotal-ai/workspace": patch
---

Teardown now refuses a live recorded process whose `<pidfile>.identity` pin exists but cannot be read, such as a pin the stopping user has no permission to read or a directory at the pin path. Any pin read error used to count as a missing pin, so `cotal down` and the manager, delivery and auth-service stops warned that the record predated identity pinning and signalled the process without the identity check. Only a missing pin takes that legacy path now. `verifyIdentityPin` reports the new `unreadable-pin` verdict with the read error, and `identityUncertaintyRefusal` names it. The record and pin are preserved, and a record whose pid is already dead still clears.
