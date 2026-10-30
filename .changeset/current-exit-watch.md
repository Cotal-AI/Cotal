---
"@cotal-ai/manager": patch
---

Honor exit-watcher cancellation for terminal streams, already-exited handles and pending exit proof. Dispose completed stream subscriptions and keep late exits from notifying for a replacement handle.
