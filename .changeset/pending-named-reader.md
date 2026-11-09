---
"@cotal-ai/delivery": patch
"cotal-ai": patch
---

`cotal pending <agent>` now exits 0 when its bounded candidate read finishes and the temporary reader is deleted.

The read uses one of the admin credential's own history readers and deletes only the reader it created. A reader already under one of those names is left in place, and a read that cannot find a free name stays partial.
