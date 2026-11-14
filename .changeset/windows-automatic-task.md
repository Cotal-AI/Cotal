---
"cotal-ai": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Keep Windows CLI installations current through a separate Task Scheduler update helper.

The helper holds a no-breakaway native job until its accounting and full process list confirm it is empty. Interrupted helpers pause automatic installation in the same boot and show a restart or manual-update remedy. A successful manual update or a later verified boot clears that pause. Desktop runtimes still use their signed installer.
