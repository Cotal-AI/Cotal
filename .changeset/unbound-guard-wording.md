---
"@cotal-ai/core": patch
---

An endpoint that is reconnecting reports that from every unbound guard. `notLiveMsg()` already said "reconnecting - try again shortly" during a rebuild or a retry backoff, and "endpoint not started" only before the first start. The guards that hard-coded the second wording now call it, so a caller waiting out a reconnect is not told the endpoint was never started.
