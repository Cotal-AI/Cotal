---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
"@cotal-ai/core": minor
---

An empty message id is never a dedup key, and an id-less delivery is individually addressable at the drain seam.

Two distinct messages that each carry an empty id collapsed to one: the receiver-side id
dedup read empty-equals-empty as a duplicate, silently dropped the second, and once the
first was handled it dropped every later empty-id message on arrival. Measured live, two
such messages arrived on the wire and only the first was ever delivered.

An empty id is now treated as no id: the ingest coalescing (pending, handled, protected)
is skipped for it in both directions, so distinct messages that carry an empty id are all
delivered. At the drain seam a per-delivery receive key (the wire id when there is one, a
per-session secret-namespaced minted key when the id is empty, never on any wire) is what
hosts, adapters, and the exact-key drain select by: cotal_inbox, the Claude Code hooks,
the OpenCode plugin, the Codex host, the Hermes bridge and its Python sidecar, and the pi
driver. The drain API is renamed for what it takes (drainInboxDeliveries, missingKeys).
Eviction classification, in-flight holds, scope routing, the focus-recall tie-break, and
the scoped drain's selection no longer key on the empty id either. The Hermes bridge no
longer wedges on an empty-id message. Delivery pumps in core now treat an absent or
non-string id as a malformed envelope per SPEC section 5 (durable terminate, live drop,
history and recall skip).

What this restores: before the receive key, an id-less delivery was unaddressable: the
raw id swept every pending empty-id item in one drain call, and once filtering closed
that, the item could never be drained or acked, was re-shown on every windowed inbox
read, and on a durable channel accumulated as an unretirable entry until the 200-entry
overflow valve evicted it, roughly a model turn of churn per entry, while one hostile
empty-id ambient publish self-drove back-to-back host turns on the pi adapter. This was
a violation of the SPEC section 8 ack-only-after-surfaced obligation at the receiver,
not only an adapter defect.

The cost is stated rather than hidden: with no id there is no coalescing either, so a
redelivered copy of an empty-id message can surface twice on a path that is already
at-least-once (live remains at-most-once). Dedup for real ids is unchanged: their
receive key is their wire id and their coalescing is untouched. SPEC section 4, section
7 item 5, section 8, and section 12 item 12 now state the receiver-scoped rule, and the
client-builder guidance mirrors it.

One named follow-up stays open: Plane-3 durable fan-out derives its publish msgID from
the message id, so distinct empty-id messages can still be collapsed inside the broker's
duplicate window on a durable channel before this receiver sees them. That path is its
own issue; this change's guarantee is the receiver.
