---
"@cotal-ai/core": minor
---

Add a DM-only consume mode to `CotalEndpoint`. With `dmOnly: { handler }`, an endpoint whose credential grants only its own DM durable binds that existing `dm_` durable and reads nothing else: no presence, channel registry, channel subscription, delivery durable, history or JetStream account lookup. A missing durable fails start with `DmDurableMissingError` (`dm-durable-missing`) and a refused bind with `DmBindRefusedError` (`dm-bind-refused`); the durable is never created and no other credential is tried. Messages pass the existing sender check before the handler, which runs one DM at a time. `stop()` resolves after the running handler settles and the connection closes, and throws when either cannot be proven. A copy the client received after `stop()` began or after a reconnect replaced the connection is left unacked for redelivery, and an ack on a closed connection throws.
