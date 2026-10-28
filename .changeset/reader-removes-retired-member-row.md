---
"@cotal-ai/core": patch
---

The delivery daemon's trusted reader removes a retired lifecycle's member row when it drops an inbox entry fanned out against it. Such a row is left when a daemon dies between creating the row and its post-write ACL read; it authorizes nothing, but every later message on the channel was copied into the retired inbox and dropped again until the row went. The row goes by its exact key, only when it exists, where that cost is paid.
