---
"@cotal-ai/auth": patch
---

Refuse a native service endpoint gate as a session serving gate. The auth session redemption hooks now reject a service-family gate before they return a serving pin or stage any caller or serving ledger row, including a restage whose saved pin was taken while the gate was ordinary.
