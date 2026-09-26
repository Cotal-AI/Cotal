---
"@cotal-ai/core": minor
---

Create each space's artifact Object Store with no byte cap, so it reserves nothing against the broker's JetStream file store.

nats-server reserves a stream's whole `max_bytes` against the server's `max_file_store` the moment the stream is created, empty or not, and refuses the next stream with JetStream error 10047 (`insufficient storage resources available`) once the reservations would pass the cap. Every space's artifact store was created at 4 GiB, so the per-space artifact quota bounded how many SPACES a broker could hold rather than how many bytes a space could write. On one production host nine spaces reserved 36.56 GiB of a 36.75 GiB cap while all nine stores together held 6,060 bytes, and the tenth space could not be provisioned. Reproduced on a real broker under `max_file_store: 9 GiB`: two spaces provisioned, the third refused with 10047, `reserved_storage` 8.19 GiB, 0 bytes stored.

The trade-off, plainly: artifacts are now bounded by the broker's file-store cap, like every other stream a space owns (`chat`, `dm`, `inbox` and `delivery` already carry `max_bytes: -1`), and no longer by a per-space quota. One space can therefore fill the broker's store with artifacts where before it could fill only its own 4 GiB. An operator who wants a per-space artifact bound sets it on the store deliberately, and setup will refuse to widen it. `discard: new` is unchanged, so reaching the bound still refuses a put rather than evicting an artifact whose reference is already published.

A store left at exactly the legacy stock 4 GiB is updated to `-1` and read back, so an existing mesh releases its reservation on the next `cotal up`; the `provisioner` credential gains `$JS.API.STREAM.UPDATE` on `OBJ_<artifact bucket>` and nothing else for it. Any other positive `max_bytes` was a deliberate decision and is still refused as drift. Every other drift check on the store is unchanged: subjects, mirror/sources, `discard: new`, file storage, limits retention, rollup headers, `max_age: 0`, sealed, and the message and size limits. `ARTIFACT_STORE_MAX_BYTES` is removed from the public surface.

The old comment claimed 4 GiB was "roughly sixteen artifacts at the 256 MiB per-artifact ceiling". No such ceiling exists or existed: a 257 MiB put succeeded against a stock store, and the 256 KiB bound in the codebase belongs to contract artifacts (SPEC §13.7), which are a different thing. The claim is gone and no ceiling was added.
