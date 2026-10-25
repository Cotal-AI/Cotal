---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A command in a project folder whose stack is stopped with no registration, as after the `down` of a
space not named after its folder or in a moved project, now refuses `TARGET_UNAVAILABLE` with another
space selected too, naming the space its account names and `cotal up` there. It used to reach the
selected space, so `send` stored the message there and `ps` listed that space's manager.
