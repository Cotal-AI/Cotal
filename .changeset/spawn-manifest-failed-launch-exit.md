---
"@cotal-ai/cli": patch
---

`cotal spawn -f` now reports a deploy with a failed agent launch as partial. When any launch fails, the summary opens with `! partial deploy onto "<space>"` and names the failed agents, and the command exits 1, as `down -f` does for a partial teardown. The ledger is still written for the channels and agents this run did create. It used to print `✓ deployed onto "<space>"` and exit 0 after the failure line. A launch that settles uncertain is listed as pending and does not change the exit status.
