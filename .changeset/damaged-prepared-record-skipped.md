---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A prepared space record that cannot be read no longer stops every command. Commands about other spaces skip it with a `PREPARED_RECORD_SKIPPED` warning naming the file, a command about its own space still refuses, `cotal space forget <space>` removes it, and `status` lists it as unreadable.
