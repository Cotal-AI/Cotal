---
"@cotal-ai/cli": patch
---

`cotal down` now calls an extension-removal reservation (`removing:<pid>`) stale only when its owner is proven gone or is not a pid. When the kernel will not report whether the owner pid is running, the stop refuses naming that pid and preserves the file without advising the operator to delete a reservation whose removal may still be in progress.
