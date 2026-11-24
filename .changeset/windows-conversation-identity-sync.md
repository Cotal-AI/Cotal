---
"@cotal-ai/cli": patch
---

Fix native conversation connections to signed-in meshes on Windows. Cotal now opens the saved identity record with write access when flushing it to disk, so the request can reach the approval step instead of failing with an `fsync` permission error.
