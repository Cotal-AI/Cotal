---
"@cotal-ai/connector-core": patch
---

Report a bound session as degraded when consecutive presence writes fail, even if core NATS remains connected. Include the observed bucket write failure in connection status and clear it when writes recover.
