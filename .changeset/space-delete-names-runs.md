---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`space delete` now lists the workflow runs that have not finished, with their recorded state, in its
dry run, its typed confirmation and its receipt, says that a run waiting for an answer goes with the
space, and names `cotal up`, then `cotal run show <run>`, to read a run's open request first. It used
to delete them without a word. The `teardown` credential's grant now reads run states: one direct get
on the space's records bucket, confined to run status keys, on a stream it could already delete.
