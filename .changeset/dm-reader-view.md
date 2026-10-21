---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

Add the `dm-reader` exchange view and the purpose-bound IdP proof it rides. An embedding can now read one user's own DMs with a credential that holds only that user's DM durable. The callout mints consumer info, next message and ack on the user's own `dm_` durable plus its connection inbox, and nothing else; core gains the matching `dm-reader` profile. The view is loopback-only and needs no ledger scope. It is exchanged only for a proof on the new `dmReaderAudience` IdP pin field, which must differ from `audience`, carrying `purpose: "dm-reader"` and the requested actor, the actor's current lifecycle and this space. The bearer and its broker connection expire no later than the proof.

Breaking for embedders that put a `purpose` claim on ordinary IdP tokens: the ordinary verifier now refuses any token carrying `purpose`, at every door that takes a human proof.
