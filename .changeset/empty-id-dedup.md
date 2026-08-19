---
"@cotal-ai/connector-core": patch
---

An empty message id is never a dedup key, and an id-less delivery is individually addressable at the drain seam.

Two distinct messages that each carry an empty id collapsed to one: the receiver-side id
dedup read empty-equals-empty as a duplicate, silently dropped the second, and once the
first was handled it dropped every later empty-id message on arrival. Measured live, two
such messages arrived on the wire and only the first was ever delivered.

An empty id is now treated as no id: the ingest coalescing (pending, handled, protected)
is skipped for it in both directions, so distinct messages that carry an empty id are all
delivered. At the drain seam a per-delivery opaque receive key (the wire id when there is
one, a minted key when the id is empty) is what hosts, adapters, and the exact-id drains
select by: cotal_inbox, the Claude Code hooks, the OpenCode plugin, the Codex host, the
Hermes bridge, and the pi driver. Before it existed, the raw id both swept every pending
empty-id item in one drain call and, once filtering closed that, left each id-less
delivery unaddressable: re-shown on every windowed inbox read, never ackable on a durable
channel, so JetStream kept redelivering it until the 200-entry overflow valve evicted it,
roughly a model turn of churn per entry. On the pi adapter one hostile empty-id ambient
publish self-drove back-to-back host turns until then. Eviction classification, in-flight
holds, scope routing, and the focus-recall tie-break no longer key on the empty id
either. The Hermes bridge no longer wedges on an empty-id message (its delivered-ack
matched the falsy wire id and never fired).

The cost is stated rather than hidden: with no id there is no coalescing either, so a
redelivered copy of an empty-id message can surface twice, which is the wire contract's
at-least-once stance. Dedup for real ids is unchanged: their receive key is their wire id
and their coalescing is untouched. SPEC section 4 and the client-builder guidance now say
the same, so a client built from the spec does not reproduce the collapse.

Two follow-ups are named and not hidden: Plane-3 durable fan-out derives its publish
msgID from the message id, so distinct empty-id messages can still be collapsed inside
the broker's duplicate window on a durable channel before this receiver sees them (its
own issue), and at the graded sha the reference implementation violated its own SPEC
section 8 ack-only-after-surfaced obligation through these paths, which this change
restores.
