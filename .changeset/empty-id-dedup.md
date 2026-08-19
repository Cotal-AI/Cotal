---
"@cotal-ai/connector-core": patch
---

An empty message id is never a dedup key at ingest.

Two distinct messages that each carry an empty id collapsed to one: the receiver-side id
dedup read empty-equals-empty as a duplicate, silently dropped the second, and once the
first was handled it dropped every later empty-id message on arrival. Measured live, two
such messages arrived on the wire and only the first was ever delivered.

An empty id is now treated as no id: the ingest coalescing (pending, handled, protected)
is skipped for it in both directions, so distinct id-less messages are all delivered.
The cost is stated rather than hidden: with no id there is no coalescing either, so a
redelivered copy of an id-less message can surface twice, which is the wire contract's
at-least-once stance. Dedup for real ids is unchanged. SPEC §4 and the client-builder
guidance now say the same, so a client built from the spec does not reproduce the
collapse.
