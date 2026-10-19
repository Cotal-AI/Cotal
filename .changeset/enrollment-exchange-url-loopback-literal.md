---
"@cotal-ai/manager": patch
---

The manager's managed-agent enrollment reader now accepts a plain `http://` agent bearer exchange URL only for a loopback IP literal, using the same `isLoopbackLiteral` rule as `cotal agent-bearer`. It used to accept `localhost`, a name whose resolution chooses where the actor token travels, and refused loopback literals such as `127.0.0.2` and `[::ffff:127.0.0.1]` that `agent-bearer` accepts.
