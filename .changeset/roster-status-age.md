---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Presence now carries `activitySince`, the epoch ms when the current activity was set. A status change or a heartbeat does not move it, so an activity left behind while hooks flip the status every turn no longer reads as fresh beside a `statusSince` that moved on the last flip. `cotal_roster` prints its age after the activity, such as `(set 9h ago)`, and dates only a finite stamp, so a record holding `null`, a string or an exponent literal such as `1e400` renders no age.
