---
"@cotal-ai/workspace": patch
---

Removing a pid record whose identity pin path holds a directory now refuses with a message that names the directory and keeps the record. It used to end with Node's raw `ERR_FS_EISDIR` text, so `cotal down` printed a filesystem error instead of saying what was wrong and what to do.
