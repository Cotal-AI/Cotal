---
"@cotal-ai/core": patch
---

fix(core): reconcile presence/lease bucket TTLs at `cotal up`

A presence or lease KV bucket created by a cotal that predated the bucket TTLs kept no `max_age` and never expired dead presence records or stale leases, so a crashed agent could linger in the roster / raw KV as live indefinitely (#286). `kvm.create(bucket, { ttl })` never updates an existing bucket, so repeat `cotal up` runs could not fix it either. `setupSpaceStreams` now reconciles the three TTL'd buckets' `max_age` via `STREAM.UPDATE` on every `cotal up` (idempotent: a bucket already at the TTL is skipped; the `duplicate_window` is lowered in the same update to satisfy `duplicate_window <= max_age`), and the `provisioner` credential is granted `STREAM.UPDATE` on exactly those three streams — nothing else. The reconcile reads the config back afterwards and throws if the update did not take, rather than reporting a success that never applied. `reconcileBucketTtl` is exported so that fail-closed behaviour can be driven directly against a broker that accepts an update without applying it.
