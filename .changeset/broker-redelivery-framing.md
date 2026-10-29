---
"@cotal-ai/connector-core": patch
---

Label broker redelivery separately from model handling: frames keep the broker delivery count and say the prior model handoff is unknown when no separate handoff evidence exists.
