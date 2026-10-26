---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

`run-status` and `cotal run show --json` now carry the run's `programHash`, the same value its
`run-ps` row carries, read from that run's own program record. Checking one run's program identity
no longer needs a full `run-ps` scan of every run. The hash is absent when the run has no recorded
program. A program record that cannot be read or parsed gives `programUnreadable` with its reason
and no hash, and the rest of the status view is unchanged. The manager contract moves to revision 39.
