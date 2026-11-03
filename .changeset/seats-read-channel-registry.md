---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Seats see the channel registry again. Since seats stopped watching presence, they had also stopped
watching the channel registry: `cotal_channels` and `cotal_channel_info` showed no registered
channel and no description, the boot briefing carried no channel notes, and a join treated every
channel as durable. A seat now reads the registry on demand with `CotalEndpoint.readChannels()`, a
batched Direct Get that binds no consumer: once at connect, and again before it lists channels,
looks one up, joins or leaves.
