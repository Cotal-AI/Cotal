---
"@cotal-ai/core": patch
---

`CotalEndpoint.readMembership()` reads the membership feed with paged batched Direct Gets and binds no consumer. The observer and admin profiles gain `$JS.API.DIRECT.GET.KV_cotal_membership_<space>`. Before, each read bound an ordered consumer whose delete those profiles may not send, so every dashboard poll left a consumer to the broker's inactive threshold and a refused `CONSUMER.DELETE` line in the broker log (#4123). A credential an older issuer minted without the row is refused with the grant it lacks and the remint to make; it is not scanned instead.
