---
"@cotal-ai/workspace": minor
---

`removeIdentityPin` is no longer exported. It removed a pid record's identity pin with no lock and no check that the pidfile still named the record, so a caller could strip the pin while `writePidPair` held the publish lock. Remove a record with `removePidPair`, which holds that lock and leaves a successor's record whole.
