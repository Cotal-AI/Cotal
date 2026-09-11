---
---

Move the scheduled mutation-reproof sweep's tracking-issue alarm into a dependent job that reads
the sweep's result. The alarm used to be a trailing step inside the sweep job gated on
`failure()`, so a sweep ended by its own 360-minute timeout (recorded as `cancelled`) never filed
or refreshed the issue; the new job fires on a failed or cancelled sweep and names which it was.
