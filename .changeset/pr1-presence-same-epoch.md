---
"@cotal-ai/core": patch
---

Order same-epoch presence puts so a late success cannot erase a newer refusal record. PublishPresence now snapshots a per-put generation and a success clears the presence-refusal record only when its put is still the newest one in flight; an earlier put that succeeds after a later put rejected no longer reports a refusing bucket as healthy. The cross-epoch fence is unchanged. Refs #1461.
