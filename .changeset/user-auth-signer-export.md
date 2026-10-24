---
"@cotal-ai/workspace": patch
---

`cotal auth signer` now refuses `UNSUPPORTED` on a per-user-auth space, as `cotal auth mint` does, and writes nothing. It used to export the space's data-account signer there.
