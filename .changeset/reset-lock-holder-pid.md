---
"@cotal-ai/cli": patch
---

A `reset store` or `reset space` that finds the root's maintenance lock held, as when it starts at
the same time as `up`, now names the holder. It refused `CONFLICT` with "the exclusive local
maintenance lock could not be acquired", with no pid and no Next. It now refuses `LIFECYCLE_BLOCKED`
(exit 2) the way `up` and `down` do: it names the pid of the command that holds the lock, removes
nothing, and its Next says to run it again once that command exits.
