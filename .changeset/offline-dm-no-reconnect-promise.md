---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/tui": patch
"cotal-ai": patch
---

A direct message to an offline agent no longer says it will be delivered when that agent reconnects.

The roster card does not say the lifecycle's DM durable still exists. A confirmed chat retirement deletes it, and a later session under the same name does not receive the message. `cotal send`, `cotal chat`, `cotal join`, the console and `cotal_dm` now say the message was stored while the agent is offline, and that a new agent spawned under that name does not receive it.
