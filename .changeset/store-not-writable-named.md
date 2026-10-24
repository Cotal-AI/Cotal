---
"@cotal-ai/cli": patch
---

`cotal up` over a broker store this account could not write exited 5 with "its log records the cause", and only the broker's log said "storage directory is not writable". `cotal status` afterwards said to start the space with `cotal up` again. `up` now checks the store before the broker starts and refuses `PERMISSION_DENIED`, exit 2, naming the store and `chmod -R u+w`, and `status` names the same step for that space.
