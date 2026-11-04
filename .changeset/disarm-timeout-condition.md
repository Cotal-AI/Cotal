---
"@cotal-ai/core": patch
---

`disarmMembershipWatch` no longer computes a `dyingEpochTimeout` term when a consumer delete fails. The term was a timeout on a reconnecting or closed connection, and the branch it fed already caught every timeout, so it read the connection state on each delete timeout and never changed the result. The catch now branches on a timeout or a closed connection alone. Behavior is unchanged.
