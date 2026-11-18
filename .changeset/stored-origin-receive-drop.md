---
"@cotal-ai/core": patch
---

Drop a message that carries the broker's stored-message headers (`Nats-Stream`, `Nats-Subject`, `Nats-Sequence`, `Nats-Time-Stamp`) on every messaging receive path: the live channel subscription, the DM, role and delivery pulls, the delivery daemon's fan-out writer, catch-up and trusted reader, channel history, recall and join backfill, the operator tap, and control requests. The endpoint request rails use the same check, now exported as `hasStoredOrigin`.
