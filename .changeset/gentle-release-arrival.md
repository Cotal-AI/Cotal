---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Updates wait for a newly announced release that npm does not serve yet instead of reporting a failed installation.

When npm returns ETARGET for the selected latest cotal-ai version, the updater leaves installed packages unchanged and reports that the release is still arriving. Manual updates exit successfully with a deferred message. Automatic updates retry on the next scheduled attempt without consuming the version's failure budget. Other npm resolution errors retain their existing failure handling.
