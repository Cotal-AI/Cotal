---
"@cotal-ai/cli": patch
---

A bare `down` interrupted after it signalled a member that had not exited yet now names that stop's
request in its notice: `cotal down --yes` stops the member again while it runs, and once it has
exited, `cotal down --abandon-stop <request-id> --yes` finishes the stop. The notice used to name
only `cotal down --yes`, which refuses once that member is gone.
