---
"@cotal-ai/manager": patch
---

In a space with more than one static manager, `inspect` for a seat hosted by another manager instance now says so. The class queue hands the read to either instance, and the one that did not host the seat answered `not-found: no agent "<name>"`, the same reply as a name that exists nowhere. A named `cotal_despawn` resolves its target through this read, so it refused a live seat with an error that read as absence whenever the lookup reached the other manager. On a live-map miss the manager already reads the durable slot; when a nonretired slot names a sibling instance as its owner it now answers `failed-precondition` with the slot detail plus `ownerInstanceId`, and a message that names the owning instance. A name with no slot, or only a retired one, is still `not-found`.
