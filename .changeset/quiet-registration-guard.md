---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

Keep remote Manager registrations protected while their registration executor is connected.

Host reconciliation now requires complete liveness evidence that both the target's serving principal and its separate registration executor are gone before changing its credential family or reopening its gate. The executor identity comes from the target gate, including for cross-owner recovery. Abandoned registrations remain recoverable, and incomplete evidence refuses recovery.
