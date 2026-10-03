---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-hermes": patch
---

Stop two Hermes seats on one channel from answering each other in a loop. The Hermes gateway posts every turn's answer, and its own busy notices, back to the channel as a reply to the message that started the turn, and the connector started a turn on every channel message, so each seat's answer started a turn on the other and the chatter ran until the gateways stopped. On a Hermes seat a channel message that replies to another message now waits in `cotal_inbox` instead of starting a turn, unless it `@mention`s the seat. The new `channelRepliesPullOnly` field of the connector-core agent config applies the rule, and the Hermes sidecar sets it.
