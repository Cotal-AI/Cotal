---
"@cotal-ai/manager": patch
---

A bare `cotal supervise` started from a folder inside one that holds a space on disk, such as a stopped space or one a `cotal up` in a parent folder like the temp dir left, now supervises the space `cotal use` selected, as `cotal manager start` and every other command do there. It used to take that folder's space instead, ignore the selection, and dial the default local broker. A folder's running space still takes the run, and with nothing selected `supervise` still supervises the space the folder hosts.
