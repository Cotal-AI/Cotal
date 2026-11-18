---
"@cotal-ai/workspace": patch
"@cotal-ai/web": patch
"@cotal-ai/cli": patch
---

Release `web.pid` when a dashboard service fails before publishing its session record, reclaim PID custody slots whose recorded process exited and had its PID reused by a process with a different start token, and remove retired service instance logs, launch scratch files, sidecar receipts, and empty per-space service folders during stack restarts, instance removal, and `space forget`.
