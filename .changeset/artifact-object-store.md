---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"cotal-ai": minor
---

Give each space an artifact object store, with a real size limit.

The `artifact` message part references bytes that live outside the message; this is where they live.
Every space now gets a JetStream Object Store alongside its other streams, created by the same setup
that creates them and removed by the same teardown.

It carries an explicit 4 GiB cap, which is the point rather than a detail. A fresh object store ships
unlimited, and a space's account is provisioned with unlimited disk, so "the account limit bounds it"
would have bounded nothing — artifacts could grow until the disk did, starving the chat and delivery
streams sharing it. Reaching the cap refuses the write instead of evicting older objects, so a
reference published yesterday cannot quietly stop resolving.

A space resource has to be listed in five separate places — created, deleted, granted, enumerated for
backup, and recreated on restore — and being in four of them is the failure that reads as correct.
Excluding the store from backups does not mean restore skips it: restore rebuilds every excluded
resource and then asserts each one exists, so a store left out would fail a restore rather than
quietly come back missing. The store is excluded under its own class rather than borrowed from an
existing one, because artifact bytes are neither transient, derived, nor a lease, and calling them
derived would suggest something could recompute them.

Two smokes join the gate. One proves the store against a real broker by enumerating what the broker
actually holds — created, matching the inventory exactly, carrying its cap, and gone after teardown —
because create and delete are claims about a broker and cannot be checked any other way. The second
was already in the repository, asserting the stream inventory, and no script had ever run it; it is
now registered and gated, and it fails correctly on this change.
