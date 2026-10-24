---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A prepared space whose controller stack ran and was stopped read as "prepared but not started", the words for one that never ran. `status`, and every command that refuses a space that does not run, now says it is stopped, with its last operation and how it ended. When that stack recorded a file store cap below 67108865, `status` shows the cap in a `Store cap` row, and Next names `cotal up --max-file-store 67108865` or more instead of a bare `cotal up`, which would fail on that cap.
