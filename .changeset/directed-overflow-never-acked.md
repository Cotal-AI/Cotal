---
"@cotal-ai/connector-core": patch
---

Stop the connector's inbox overflow valve from dropping direct messages. When a busy session's bounded inbox filled with directed mail, the valve evicted the oldest DM and, after five evictions of the same message, acknowledged it and wrote one stderr line. The sender had seen the message stored and the recipient was live and rostered, yet its inbox never carried it. An evicted direct message or role request is now never acknowledged: it stays pending on the recipient's durable, where `cotal deliver pending <name>` counts it, and the broker redelivers it after the durable's ack wait until it finds room. Evicted channel traffic is still acknowledged as before.
