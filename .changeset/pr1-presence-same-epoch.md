---
"@cotal-ai/core": patch
---

Order same-epoch presence evidence by settle, not start: a settle (success or refusal) is the latest evidence only while no put that started after it has already settled, and a newer put merely in flight supersedes nothing. An earlier put that settles after a later put settled no longer speaks, so a late success cannot erase a newer refusal record and a record can no longer outlive a write the bucket accepted. The cross-epoch fence is unchanged. Refs #1461.
