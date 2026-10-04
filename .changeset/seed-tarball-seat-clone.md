---
---

`smoke:seed-tarball:live` now packs `@cotal-ai/seat` from a clone in its own temporary root, with a 20-byte ELF header for each Linux arch the host build did not make, so seat's prepack guard no longer stops the suite at its third pack. The real `packages/seat/build/Release` is never written, so no stand-in helper can reach a later genuine pack.
