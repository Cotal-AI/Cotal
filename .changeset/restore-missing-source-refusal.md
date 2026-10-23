---
"@cotal-ai/cli": patch
---

`backup restore` and `up --restore` with the preserved source missing and no
`--accept-missing-source` now refuse `TARGET_NOT_FOUND` (exit 2), naming the missing path and the
`--accept-missing-source` route. They reported an unknown outcome (exit 3) with a Next about a
restore attempt that did not exist, although nothing was changed.
