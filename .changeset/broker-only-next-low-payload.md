---
"@cotal-ai/cli": patch
---

Broker-only `up` receipts no longer suggest adding a manager the broker's payload limit cannot support. When the limit is below the minimum a manager starts on, the Next step names stopping the broker and restarting it with a payload it can start on instead of the bare `up` that would refuse.
