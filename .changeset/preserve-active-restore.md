---
"@cotal-ai/cli": patch
---

`down --preserve-state` while a completed restore still holds the root's maintenance journal now
refuses `LIFECYCLE_BLOCKED` (exit 2), says nothing was stopped, and names the restore attempt's
`backup cleanup-fallback` as the next step. Before, every preserve form exited 3 as an unknown
outcome with no next step.
