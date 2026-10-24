---
"@cotal-ai/cli": patch
---

`cotal space` no longer says "No spaces registered" above the prepared space it lists. With only
prepared spaces, it says no space has been started or registered yet. The prepared table's header
reads `Space  Project` instead of `SPACE  Project`, and the registered table's `ROOT` column is
`Project`, as in the prepared table.
