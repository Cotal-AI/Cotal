---
"@cotal-ai/cli": patch
---

Avoid a misleading startup warning when a foreground start is interrupted. The startup observer no longer reports the control plane as degraded while the guarded stop is in progress; genuine startup failures still produce their warning.
