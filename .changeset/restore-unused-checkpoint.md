---
"@cotal-ai/cli": patch
---

Restore full backups on NATS 2.12 when a new consumer reports a zero acknowledgement floor. Keep the snapshot's replay start and require unused consumer counters before accepting the checkpoint.
