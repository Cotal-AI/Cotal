---
"@cotal-ai/cli": patch
---

`cotal backup verify` accepts an unchanged Windows artifact whose NTFS file ids are larger than a JavaScript number can hold, and still refuses a file that was replaced.
