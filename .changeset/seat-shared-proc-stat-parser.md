---
"@cotal-ai/seat": patch
---

Share one validated `/proc/<pid>/stat` parser across seat record, reap, launcher, and custodian readers so a malformed stat line is rejected consistently instead of slicing from an unguarded offset.
