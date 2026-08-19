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
delivered. The exact-id drain follows the same rule: a host request to drain by a
surfaced empty id selects nothing, where it previously swept every pending empty-id
item in one call, acking messages the host never surfaced. The cost is stated rather
than hidden: with no id there is no coalescing either, so a redelivered copy of an
empty-id message can surface twice, which is the wire contract's at-least-once stance.
Dedup for real ids is unchanged. SPEC §4 and the client-builder guidance now say the
same, so a client built from the spec does not reproduce the collapse.

Two follow-ups are named and not hidden: connector adapters key their surface/commit
bookkeeping by raw id, and Plane-3 durable fan-out derives its publish msgID from the
message id, so distinct empty-id messages can still be collapsed inside the broker's
duplicate window on a durable channel before this receiver sees them. Each is its own
issue; this change's guarantee is the receiver-side seam.
