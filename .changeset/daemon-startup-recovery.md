---
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

On Linux, native `cotal daemon serve` startup update-recovery no longer waits inside its reconcile child for `daemon.sock` before `daemon.sock` exists, including when restoring an older published CLI release onto disk. Starting or restarting an already-installed `cotal-daemon.service` unit (`cotal daemon start`, `cotal daemon setup`, and update activation) now passes a 65-second call timeout derived from `TimeoutStartSec=60` to `systemctl --user start`, and waits up to 60 seconds for `Restart=always` to bring up the restored daemon at the previous CLI version when startup recovery cleared a restorable interrupted-update record. When `cotal daemon setup` updates the service's pinned `PATH`, it now reports `updating <unit> pinned PATH` before rewriting the unit and `restarted <unit> with the updated PATH` after the restart completes. If `cotal daemon start` or `cotal daemon setup` cannot reacquire the local update-closure or daemon service lock after native recovery finishes, it refuses with `DEPENDENCY_UNAVAILABLE` (exit `2`) instead of failing untyped or waiting unboundedly.
