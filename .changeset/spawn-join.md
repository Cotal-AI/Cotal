---
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
---

`cotal_spawn` takes `join`: concrete channels the new peer joins at start, on top of what its persona file lists. Each is checked against the caller's own read ACL before the request is sent, so a spawn never hands on a channel the caller may not read. The request also carries the caller's read and post ACL as `callerAcl`; the manager consults it only for a persona that names no channel field at all, so such a helper is scoped to its spawner, never wider, and the spawner's event channel is never part of it. The joined set is not copied from the spawner: without `join`, a channel-less persona still starts on no channel. The manager's `spawn` operation accepts both fields; a manifest launch rejects them like the other imperative overrides.

A `cotal_send` with no channel and no default is now refused with the channels the agent may post to and the exact next call (`cotal_send` with `channel`, or `cotal_join` to make one the default), instead of pointing at the orientation card. The orientation card lists the concrete channels in the read ACL the agent is not on yet, each with its registry note. The briefing's channel paragraph leads with the model (information moves through channels; subscribe to what you need, publish what others need), then the rule (the channel for work, a mention only to make one peer act now, a DM only for what one peer alone needs), then the mechanics, and says a spawned helper needs `join`.
