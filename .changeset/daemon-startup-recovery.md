---
"cotal-ai": patch
---

On Linux, native `cotal daemon serve` startup update-recovery no longer waits inside its reconcile child for `daemon.sock` before `daemon.sock` exists. Starting or restarting an already-installed `cotal-daemon.service` unit (`cotal daemon start`, `cotal daemon setup`, and update activation) now passes a 65-second call timeout derived from `TimeoutStartSec=60` to `systemctl --user start`, and waits up to 60 seconds for `Restart=always` to bring up the restored daemon at the previous CLI version when startup recovery cleared a restorable interrupted-update record.
