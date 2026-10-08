---
"@cotal-ai/connector-opencode": patch
---

The OpenCode 1.x plugin's teardown comments no longer say a seat has two ways out. They now state that every way a running seat stops goes through `shutdown` and its shared teardown, which includes a required event plane that stopped for good and exits 1. No behavior changes.
