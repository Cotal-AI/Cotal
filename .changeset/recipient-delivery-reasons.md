---
"@cotal-ai/core": patch
---

A consented recipient's DLV delivery now reports the trusted reader's reason for that one copy: `RecipientDelivery.category` is `durable-channel` or `live-mention` when the copy carries the reader's frame header and exactly one recognized `Cotal-Delivery-Reason` value, and `unknown` otherwise, with an unrecognized value in `unrecognizedReason`. A DM delivery stays `dm` and its headers are never read. `recipientDeliveryOf` builds the observation from one fetched message, and the reader and every consumer share one header rule (`delivery-reason.ts`), so the member endpoint's `MessageMeta.deliveryReason` follows the same checks. The version-1 frame body is unchanged.
