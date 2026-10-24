---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Shell completion no longer writes a warning, such as the one for a prepared space record it skips,
unless `COTAL_COMPLETE_DEBUG` is on. Unset, empty, `0`, `false` and `off` keep it quiet, as they do
for a completion's errors. The docs now say the shell stubs discard stderr, so a completion's
diagnostics show only when `cotal __complete <words>` runs by hand.
