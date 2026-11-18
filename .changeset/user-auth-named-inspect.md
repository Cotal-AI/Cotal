---
"@cotal-ai/connector-core": patch
---

Route named `manager.inspect` calls from user-auth seats to the peer's holding manager through live presence and a manager-call bearer for that instance, so `cotal_invoke` `manager` `inspect` no longer fails across two user-mode managers.
