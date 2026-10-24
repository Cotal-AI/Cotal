---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
---

`cotal run answer` for a run ID that no run is recorded under now says no run is recorded under
that ID, where it said no step is recorded under that key. With `--local` it is refused
`TARGET_NOT_FOUND`, exit 2, as the hosted answer is, where it reported an unknown outcome although
nothing was written.
