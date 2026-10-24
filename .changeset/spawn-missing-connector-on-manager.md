---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A managed spawn that a manager cannot run because it has no agent application installed is now
refused with `DEPENDENCY_UNAVAILABLE`, as a spawn in this terminal is, whether it is pinned with
`--on` or sent unpinned with `-d`. Both refusals name the manager and the host its status reports,
and say to add the application where that manager runs, then restart it.
