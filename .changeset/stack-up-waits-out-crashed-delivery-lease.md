---
"@cotal-ai/cli": patch
---

A controller stack now comes back after a crash. When every stack member was killed, both the
documented `cotal down --yes` then `cotal up` and a direct `cotal up` used to exit 4: the new
delivery daemon found shard 0 still leased to the killed one and refused to bind. The controller
`up` now waits out a delivery lease held by the credential the folder gave its previous daemon,
as the legacy launcher already did, and `down` keeps that credential when the delivery daemon was
already gone, so the next `up` can still recognise the row. Its JSON `cleanup` field then reads
`registration-removed-delivery-credential-kept`.
