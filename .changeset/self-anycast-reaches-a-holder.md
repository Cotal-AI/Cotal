---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

An anycast a seat sends to a role it holds itself is no longer lost. The endpoint used to ack any message from itself as an echo on its DM inbox and role queue consumers, and on the role's work queue that ack deleted the only copy, so neither the sender nor any other holder, present or later, ever received the request. Those consumers now deliver the sender's own anycast, and its own DM, like any other addressed message. `cotal_anycast` counts the sender among the holders online at send when it holds the role, since its own task consumer can now take the request.
