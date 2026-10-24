---
"@cotal-ai/cli": patch
---

`up` of a stack whose `.cotal/auth/server.conf` is a symlink or a folder, or whose trust record this
account cannot read, no longer exits 3 `OPERATION_UNKNOWN` saying started members were kept while
nothing started. It refuses `PERMISSION_DENIED` (exit 2) before it starts anything, in text and
`--json`, carries the cause, and names the path and the step: move the generated configuration
aside, or make the trust record readable again.
