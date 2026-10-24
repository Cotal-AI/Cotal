---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A full restore of a backup made before the state it replaced was preserved now names each workflow
run it rolled back, and each step that was answered after the backup and is open again, in its
receipt, in `cotal status` and in the `backup cleanup-fallback` preview. It says that answer is
only in the store the restore set aside. To read it, the restore copies that store and reads its
run journals on one more isolated broker, through a new read-only maintenance login on the step
journal stream.
