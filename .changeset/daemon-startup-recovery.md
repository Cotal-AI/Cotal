---
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Native `cotal daemon serve` startup update-recovery no longer waits inside its reconcile child for `daemon.sock` before `daemon.sock` exists, and `systemctl --user start` for the machine daemon now uses a 65-second call timeout derived from `TimeoutStartSec=60` and waits up to 60 seconds for `Restart=always` to bring up the restored daemon when startup recovery cleared a restorable interrupted-update record.
