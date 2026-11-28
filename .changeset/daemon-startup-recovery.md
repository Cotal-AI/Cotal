---
"cotal-ai": patch
---

On Linux, native `cotal daemon serve` startup update-recovery no longer waits inside its reconcile child for `daemon.sock` before `daemon.sock` exists, including when restoring an older published CLI release onto disk. Starting or restarting an already-installed `cotal-daemon.service` unit (`cotal daemon start`, `cotal daemon setup`, and update activation) passes a 65-second call timeout derived from `TimeoutStartSec=60` to `systemctl --user start`, and waits up to 60 seconds for `Restart=always` to bring up the restored daemon at the previous CLI version when startup recovery cleared a restorable interrupted-update record. Contended re-acquisition of the local update-closure or daemon service lock after native recovery announces the wait on standard error, stays bounded to the remaining recovery budget, and refuses with `DEPENDENCY_UNAVAILABLE` if the lock cannot be taken again.
