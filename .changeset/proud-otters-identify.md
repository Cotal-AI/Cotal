---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Pin every stack pidfile to its process's creation identity before teardown. `up` writes a sibling `<pidfile>.identity` containing the pid and process start where the OS reports one. Every stop path checks it before signalling: a reused pid or torn pin is refused and preserved, and rerunning after the process is stopped clears the stale record automatically. A live pre-pin record warns and proceeds so the first teardown after an upgrade still works; relaunching writes the pin and enables full match and mismatch protection.
