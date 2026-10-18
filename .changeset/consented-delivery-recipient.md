---
"@cotal-ai/core": patch
---

`@cotal-ai/core` exports the delivery half of a consented background recipient. `recipientDurableConfigs` and `provisionRecipientDurables` pre-create a grant's own DM and DLV durables, starting at the consent frontier from `captureRecipientFrontier`, so nothing delivered before consent is captured and the lifecycle's own durables are never shared. `recipientBindGrants` is the recipient's whole JetStream surface: info, fetch and ACK of those durables. `nextRecipientDelivery` and `commitThenAck` persist before the ACK, NAK a failed persist, and give each delivery a stable `<stream>:<sequence>` source id for dedup. `deprovisionRecipientDurables` deletes them by exact name. DLV deliveries carry category `unknown` until a trusted delivery reason exists. `consumeBindRows` is now exported. The consent record and the recipient credential are not part of this change.
