---
"@cotal-ai/cli": patch
---

`cotal team deploy` names the cards it refuses for lacking `deliveryClass: live` and says what to do:
set it on each card, or create a durable channel with `cotal channel set <name> --delivery durable`.
`team deploy --dry-run` warns `LIVE_DELIVERY_REQUIRED` for the same cards, so the preview says the
apply would refuse. The manifest page lists each card's keys, `deliveryClass` among them.
