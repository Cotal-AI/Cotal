---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
---

Saving a persona now requires it to name the channels it reads. `saveAgentFile` refuses a
definition with no `subscribe`, `cotal personas new` takes a required `--subscribe` (pass
an empty value for an agent reachable only by direct message and anycast), and a persona
defined over the wire is created with an empty read set, since that path deliberately
accepts no policy from its caller. Previously a saved persona with no read set inherited
whatever default was current, so a file could grant a channel its author never chose and a
later reader could not tell a deliberate silence from a forgotten field. An empty list is
written rather than filled in, so the two stay distinguishable.
