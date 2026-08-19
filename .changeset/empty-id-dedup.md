---
"@cotal-ai/connector-core": patch
---

An empty message id is never a dedup key at ingest.

Two distinct messages that each carry an empty id collapsed to one: the receiver-side id
dedup read empty-equals-empty as a duplicate, silently dropped the second, and once the
first was handled it dropped every later empty-id message on arrival. Measured live, two
such messages arrived on the wire and only the first was ever delivered.

An empty id is now treated as no id: the ingest coalescing (pending, handled, protected)
is skipped for it in both directions, so distinct messages that carry an empty id are all
delivered. At the drain seam a per-delivery opaque receive key (the wire id when there is
one, a minted key when the id is empty) lets a host drain and ack an id-less delivery
exactly, where the raw id both swept every pending empty-id item in one call and, once
filtering closed that, left the delivery undrainable and forever redelivered. The cost is
stated rather than hidden: with no id there is no coalescing either, so a redelivered copy
of an empty-id message can surface twice, which is the wire contract's at-least-once
stance. Dedup for real ids is unchanged. SPEC §4 and the client-builder guidance now say the
same, so a client built from the spec does not reproduce the collapse.

Two follow-ups are named and not hidden: some adapter bookkeeping still keys on the raw
message id beyond the drain/ack sites moved here, and Plane-3 durable fan-out derives its
publish msgID from the message id, so distinct empty-id messages can still be collapsed
inside the broker's duplicate window on a durable channel before this receiver sees them.
Each is its own issue; this change's guarantee is the receiver-side seam.
