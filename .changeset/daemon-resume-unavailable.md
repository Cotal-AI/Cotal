---
"cotal-ai": patch
---

Remembered daemon service connections recover automatically after a startup dependency outage.
The daemon retries unavailable connections with bounded backoff and cancels retries on disconnect or shutdown.
