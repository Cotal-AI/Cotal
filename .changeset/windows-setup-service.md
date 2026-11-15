---
"cotal-ai": patch
---

Windows desktop setup preserves the background service across newer-version upgrades and refuses to interrupt hosted agents.

Setup holds hosted launch admission before gracefully stopping the verified service, disables its scheduled task while replacing files, and restores its previous running or stopped state. Interrupted setup blocks service startup until the installer completes recovery. Silent refusals and unconfirmed startup write a persistent result for callers.
