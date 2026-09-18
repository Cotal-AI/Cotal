---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Bind the delivery daemon's store-identity answer to the process that reloads

The delivery-admin rail is queue-grouped, so the `reloadStoreIdentity` challenge is served by
whichever bound responder the broker picks, while only the holder of the space's delivery lease
actually reloads the standing credentials. The reply was a bare store identity and named no
process, so a non-holder answering with a matching store let a manager conclude the stores were
shared and remint into a store the reloading daemon never reads.

The reply now carries the answering endpoint's identity and its own lease claim. The manager reads
the delivery lease row itself, under its own credential, and requires the answerer to be the
recorded holder. The answerer's claim is kept as a cross-check that must agree, so an honest
non-holder is refused by its own admission and the operator-facing reason says which responder
answered and who holds the lease. An unreadable lease row is undetermined and refuses, consistent
with the existing convention that a hung rail fails closed.

The supervisor credential gains a read-only point read of the delivery lease bucket, which is what
lets the manager establish the holder itself rather than take a responder's word for it. It gains
no write, delete or purge on that bucket: a credential able to write the row could manufacture the
fact the challenge reads.

A manager newer than its delivery daemon receives the old reply shape. That is refused with a
message naming the mismatch rather than silently accepted, and each daemon's own renewal timer
remains the adoption backstop.
