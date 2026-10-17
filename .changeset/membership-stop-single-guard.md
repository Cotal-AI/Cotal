---
"@cotal-ai/core": patch
---

The stop that `watchMembership` returns now calls `finishMembershipWatchStop` directly. It used to check the retained consumer identity itself first, which repeated part of the guard inside `finishMembershipWatchStop`. One guard now decides when a stopped membership watch resolves, on both the stop path and the reconnect rearm path. Behavior is unchanged.
