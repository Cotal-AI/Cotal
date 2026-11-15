---
"cotal-ai": patch
---

The desktop app now watches local daemon status over one persistent `status-watch` stream instead of spawning a new `cotal daemon desktop` process on a timer while visible or hidden. The daemon pushes status frames when its computer name, account state, hosted Manager state, hosted agent inventory, update status or pending generation changes, and when the running daemon is on a different version the app rechecks `status` every 60 seconds and opens `status-watch` automatically once the versions match.
