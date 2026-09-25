---
"@cotal-ai/pi": patch
---

A pi seat held after a non-terminal `agent_end` (error or an unknown stop reason) with a Cotal batch pending now has a bounded exit: the driver retries the continuation itself a fixed number of times with a fixed backoff, through the same send path a human continuation uses, before holding for operator intervention with a presence that names the attempt count and what to do. User abort still holds without any automatic retry: the person who aborted is the party who continues. Fixes #726
