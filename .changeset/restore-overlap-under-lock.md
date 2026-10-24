---
"@cotal-ai/cli": patch
---

A restore whose artifact path names the preserved store or `.cotal/maintenance` only once the restore
holds the maintenance lock, such as a link changed during the restore, now refuses `USAGE_INVALID`
with the same message as the check before the lock, naming the path and that store or folder. It used
to exit 3 with an unconfirmed outcome and a message that named neither.
