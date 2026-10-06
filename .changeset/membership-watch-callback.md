---
"@cotal-ai/core": patch
---

The membership watch callback no longer builds a KV watch entry for every feed message and then discards it. `onChange` takes no argument, so the per-message entry and the replay countdown behind it were never read. `watchMembership` still calls `onChange` once per entry, initial replay included.
