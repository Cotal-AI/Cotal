---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A manager that refuses a stop request after `cotal down` stopped waiting no longer blocks the stack. The manager refuses because the `down` that published the request has exited, and it keeps running. The next bare `up` or `down` now reads that `refused` receipt, removes the request, releases the stop reservation and returns the manager's record to `running`. `down` then stops the manager, and `up` reuses it.
