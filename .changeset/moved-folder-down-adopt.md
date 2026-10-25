---
"@cotal-ai/cli": patch
---

After `down --space <space>` stops a stack whose folder was moved or renamed while it ran, its Next
names `cotal space create <space> --adopt --root <folder>` first, which keeps the folder's history,
then `cotal space create <space>` for another folder. Its plan no longer says the stack journal is gone.
