---
"@cotal-ai/cli": patch
---

`endpoints --json` now carries each participant's presence values: the condition, and the `statusSince`, `activitySince` and `activeAt` times. It used to carry the report's rendered fragments, such as `" · unchanged for 5s"`, in `facts` and `activityAge`, and a display `label`. The report still prints the same text, worked out from those values.
