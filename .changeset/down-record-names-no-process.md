---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal down` over a pidfile that holds content that is not a pid now says the record names no
process, so cotal cannot tell whether that component still runs. It used to tell you to stop "that
process" when the file named none. It still refuses, keeps the file, does not stop the broker, and
keeps the artifacts and the registration. A Next now follows: it asks you to confirm that no such
component still runs for the folder, because a manager that does not answer on the mesh may still be
running, then names `rm <pidfile>` and the same `cotal down`.
