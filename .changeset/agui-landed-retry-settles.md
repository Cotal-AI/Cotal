---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

A seat whose event frame reached the broker but whose acknowledgement was lost now settles that frame on its next start instead of stopping its event plane for good, and a halted event plane is retried at a wait that doubles up to five minutes instead of once a second. The retry proves the frame is the channel's newest one with a duplicate-window probe that can never store anything, or, once that window has closed, by reading the newest frame when the seat may read its own event channel; without either proof it halts as before.
