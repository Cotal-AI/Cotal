---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A restore interrupted after its commit intent and before it bound a listener now recovers forward with bare `cotal up`, as its refusal advises. Before, every `up` exited 3 with "re-entry has no bound listener proof" and the restore stayed stuck. `up` now starts the listener when no process of this account names the attempt and the recorded port is free, including from a `degraded` record an earlier `up` left. While a listener the interrupted run started still runs, `up` names its pid and refuses, because a second server would open the restored store beside it.
