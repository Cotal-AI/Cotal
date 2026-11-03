---
"@cotal-ai/manager": patch
---

Report the seat name and reader failure when last output cannot be read after a launch exit or failed supervised recovery. Keep the original launch/recovery failure and cleanup, but no longer make a broken reader look like an empty screen. Closed-session read failures and failed recovery attaches are also reported as output unavailable rather than silently classified as empty.
