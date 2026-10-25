---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run show` now explains that a released status records no reason and points to the executing
manager's log for hosted runs or the driving process's output for local runs. It does not infer an
execution host or log location from a journal read. Status, JSON, journal limits and resume behavior
are unchanged; this is evidence guidance, not a recorded cause or a prevention of repeated release.
