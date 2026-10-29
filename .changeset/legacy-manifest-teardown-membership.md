---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
---

Fix teardown of additive ledgers from the retired `spawn -f`. `down -f` now reports the actual membership read failure, and static teardown credentials carry the batched membership snapshot read they need. Channels remain retained when membership is uncertain.

On user-auth meshes, teardown uses the signed-in deploying owner's authority rather than a synthetic static identity whose filtered roster could hide a running agent. Membership reads and channel deletion use the existing admin and channel-writer views. An older auth issuer still requires an upgrade before it can issue the snapshot read grant.
