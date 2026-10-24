---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
---

`cotal run amend` for a run ID that no run is recorded under now says no run is recorded under that
ID. With `--local`, an amend that finds no answer to amend is refused `TARGET_NOT_FOUND`, exit 2, as
the hosted amend is, where it reported an unknown outcome although nothing was written.
